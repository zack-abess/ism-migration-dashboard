#!/usr/bin/env node
/**
 * generate_dashboard_data.js
 * ==========================
 * Scanne les dossiers Done/, Skip/, archive_classexpert/ et les stats xlsx
 * pour produire un dashboard-data.json consommé par le dashboard HTML.
 *
 * Usage: node dashboard/generate_dashboard_data.js
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

// ─── Configuration ──────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DONE_DIR    = path.join(PROJECT_ROOT, 'Done');
const SKIP_DIR    = path.join(PROJECT_ROOT, 'Skip');
const ARCHIVE_DIR = path.join(PROJECT_ROOT, 'archive_classexpert');
const OUTPUT_FILE = path.join(__dirname, 'dashboard-data.json');

const SCRAPER_TYPES = ['classes', 'notes', 'assiduite', 'pupils'];
const IGNORE_DIRS = new Set(['_debug', '_notes', '_assiduite', '_pupils', '_global', 'ISM-DAKAR']);

// ─── Helpers ────────────────────────────────────────────────────────────────

function listLicenceDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.') && !IGNORE_DIRS.has(d.name))
    .map(d => ({
      name: d.name,
      path: path.join(baseDir, d.name),
    }));
}

function extractSchoolAndYear(licenceName) {
  // Pattern: ISM_Dakar_Ecole_d'Ingénieurs_2019-2020
  const match = licenceName.match(/^(.+?)_(\d{4}-\d{4})$/);
  if (match) {
    return { school: match[1].replace(/_/g, ' '), year: match[2] };
  }
  // No year suffix — current/generic
  return { school: licenceName.replace(/_/g, ' '), year: 'courant' };
}

function findLatestStatsFile(licenceDir, scraperName) {
  if (!fs.existsSync(licenceDir)) return null;
  const files = fs.readdirSync(licenceDir)
    .filter(f => f.startsWith(`stats_${scraperName}`) && f.endsWith('.xlsx'))
    .sort();
  // Latest = last alphabetically (retry files have timestamps)
  return files.length > 0 ? path.join(licenceDir, files[files.length - 1]) : null;
}

async function readStatsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) return null;

  // Read headers
  const headers = {};
  ws.getRow(1).eachCell((cell, col) => {
    headers[String(cell.value).toLowerCase().trim()] = col;
  });

  const rows = [];
  const statusCol   = headers['statut'] || headers['status'];
  const countCol    = headers['nb entrées'] || headers['résultat'];
  const validCol    = headers['validation'];
  const classeCol   = headers['classe'];
  const classeIdCol = headers['classe id'];
  const periodeCol  = headers['période'];
  const matiereCol  = headers['matière'];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const status = statusCol ? String(row.getCell(statusCol).value || '').trim().toLowerCase() : '';
    if (!status) continue; // skip empty rows

    const count = countCol ? (parseInt(row.getCell(countCol).value) || 0) : 0;
    const validation = validCol ? String(row.getCell(validCol).value || '').trim() : '';
    const classe = classeCol ? String(row.getCell(classeCol).value || '') : '';
    const classeId = classeIdCol ? String(row.getCell(classeIdCol).value || '') : '';
    const periode = periodeCol ? String(row.getCell(periodeCol).value || '') : '';
    const matiere = matiereCol ? String(row.getCell(matiereCol).value || '') : '';

    rows.push({ status, count, validation, classe, classeId, periode, matiere });
  }

  return rows;
}

function aggregateStats(rows) {
  if (!rows) return { total: 0, ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, validated: 0, totalEntries: 0 };

  let total = 0, ok = 0, empty = 0, error = 0, noperiod = 0, nofield = 0, validated = 0, totalEntries = 0;

  for (const row of rows) {
    total++;
    if (row.validation && row.validation !== '') validated++;
    totalEntries += row.count;

    switch (row.status) {
      case 'ok':        ok++; break;
      case 'empty':     empty++; break;
      case 'error':     error++; break;
      case 'no_period': noperiod++; break;
      case 'no_field':  nofield++; break;
      default:          ok++; break; // treat unknown as ok
    }
  }

  return { total, ok, empty, error, noperiod, nofield, validated, totalEntries };
}

function countClasses(licenceDir) {
  const classesFile = path.join(licenceDir, '_classes_list.json');
  if (fs.existsSync(classesFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(classesFile, 'utf8'));
      return Array.isArray(data) ? data.length : 0;
    } catch { return 0; }
  }
  // Fallback: count subdirectories that don't start with _
  try {
    return fs.readdirSync(licenceDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'))
      .length;
  } catch { return 0; }
}

function getDirModTime(dirPath) {
  try {
    // Use most recent stats file modification time
    const files = fs.readdirSync(dirPath).filter(f => f.startsWith('stats_'));
    let latest = 0;
    for (const f of files) {
      const mtime = fs.statSync(path.join(dirPath, f)).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
    return latest > 0 ? new Date(latest).toISOString() : null;
  } catch { return null; }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📊 Génération des données du dashboard...');

  const data = {
    generatedAt: new Date().toISOString(),
    summary: { done: 0, skip: 0, inProgress: 0, total: 0 },
    totalClasses: 0,
    totalEntries: { notes: 0, assiduite: 0, classes: 0, pupils: 0 },
    schools: {},
    licences: [],
  };

  // Process each category
  const categories = [
    { dir: DONE_DIR, status: 'done' },
    { dir: SKIP_DIR, status: 'skip' },
    { dir: ARCHIVE_DIR, status: 'in_progress' },
  ];

  for (const cat of categories) {
    const dirs = listLicenceDirs(cat.dir);

    for (const lic of dirs) {
      const { school, year } = extractSchoolAndYear(lic.name);
      const nbClasses = countClasses(lic.path);
      const lastModified = getDirModTime(lic.path);

      // Per-scraper stats
      const scraperStats = {};
      for (const scraper of SCRAPER_TYPES) {
        const statsPath = findLatestStatsFile(lic.path, scraper);
        const rows = await readStatsFile(statsPath);
        const agg = aggregateStats(rows);
        scraperStats[scraper] = agg;

        // Global entries total
        data.totalEntries[scraper] = (data.totalEntries[scraper] || 0) + agg.totalEntries;
      }

      const licenceData = {
        name: lic.name,
        displayName: lic.name.replace(/_/g, ' '),
        school,
        year,
        status: cat.status,
        nbClasses,
        lastModified,
        scrapers: scraperStats,
      };

      data.licences.push(licenceData);
      data.totalClasses += nbClasses;

      // Schools aggregation
      if (!data.schools[school]) {
        data.schools[school] = { years: [], doneCount: 0, skipCount: 0, inProgressCount: 0 };
      }
      data.schools[school].years.push(year);
      if (cat.status === 'done') data.schools[school].doneCount++;
      if (cat.status === 'skip') data.schools[school].skipCount++;
      if (cat.status === 'in_progress') data.schools[school].inProgressCount++;

      // Summary
      data.summary[cat.status === 'in_progress' ? 'inProgress' : cat.status]++;
      data.summary.total++;
    }
  }

  // Sort licences: in_progress first, then done, then skip
  const statusOrder = { in_progress: 0, done: 1, skip: 2 };
  data.licences.sort((a, b) => {
    const so = (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0);
    if (so !== 0) return so;
    return a.name.localeCompare(b.name);
  });

  // Write JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✅ ${OUTPUT_FILE} généré`);
  console.log(`   ${data.summary.total} licences: ${data.summary.done} done, ${data.summary.skip} skip, ${data.summary.inProgress} en cours`);
  console.log(`   ${data.totalClasses} classes au total`);
}

main().catch(err => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});

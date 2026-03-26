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

function findAllStatsFiles(licenceDir, scraperName) {
  // Retourne le fichier original + tous les retries, dans l'ordre chronologique
  if (!fs.existsSync(licenceDir)) return [];
  return fs.readdirSync(licenceDir)
    .filter(f => f.startsWith(`stats_${scraperName}`) && f.endsWith('.xlsx'))
    .sort()
    .map(f => path.join(licenceDir, f));
}

async function readAndMergeStatsFiles(filePaths) {
  // Lit tous les fichiers stats (original + retries) et fusionne :
  // le retry met à jour les lignes existantes par clé unique,
  // sans jamais dégrader un "ok" en "no_period"/"error" (lecture seule dashboard).
  if (!filePaths || filePaths.length === 0) return null;

  // Map clé -> row (le retry écrase les lignes correspondantes)
  const merged = new Map();

  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) continue;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws || ws.rowCount < 2) continue;

    const headers = {};
    ws.getRow(1).eachCell((cell, col) => {
      headers[String(cell.value).toLowerCase().trim()] = col;
    });

    const statusCol   = headers['statut'] || headers['status'];
    const countCol    = headers['nb entrées'] || headers['résultat'];
    const validCol    = headers['validation'];
    const classeCol   = headers['classe'];
    const classeIdCol = headers['classe id'];
    const periodeCol  = headers['période'];
    const periodeIdCol = headers['période id'];
    const matiereCol  = headers['matière'];
    const matiereIdCol = headers['matière id'];

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const status = statusCol ? String(row.getCell(statusCol).value || '').trim().toLowerCase() : '';
      if (!status) continue;

      const count = countCol ? (parseInt(row.getCell(countCol).value) || 0) : 0;
      const validation = validCol ? String(row.getCell(validCol).value || '').trim() : '';
      const classe = classeCol ? String(row.getCell(classeCol).value || '') : '';
      const classeId = classeIdCol ? String(row.getCell(classeIdCol).value || '') : '';
      const periode = periodeCol ? String(row.getCell(periodeCol).value || '') : '';
      const periodeId = periodeIdCol ? String(row.getCell(periodeIdCol).value || '') : '';
      const matiere = matiereCol ? String(row.getCell(matiereCol).value || '') : '';
      const matiereId = matiereIdCol ? String(row.getCell(matiereIdCol).value || '') : '';

      // Clé unique : classeId|periodeId|matiereId (ou classeId|periodeId pour assiduité)
      const key = matiereId ? `${classeId}|${periodeId}|${matiereId}` : `${classeId}|${periodeId}`;

      const isGlobal = classe === '(global)';
      const newRow = { status, count, validation, classe, classeId, periode, matiere, isGlobal };

      const existing = merged.get(key);
      if (!existing) {
        // Première occurrence
        merged.set(key, newRow);
      } else {
        // Retry : ne jamais dégrader ok → failure
        const okStatuses = new Set(['ok']);
        if (okStatuses.has(existing.status) && !okStatuses.has(status)) {
          // Garder l'existant (ok), ne pas écraser par une dégradation
          continue;
        }
        merged.set(key, newRow);
      }
    }
  }

  return merged.size > 0 ? Array.from(merged.values()) : null;
}

function aggregateStats(rows, excludeGlobal = false) {
  if (!rows) return { total: 0, ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, validated: 0, totalEntries: 0 };

  let total = 0, ok = 0, empty = 0, error = 0, noperiod = 0, nofield = 0, validated = 0, totalEntries = 0;

  for (const row of rows) {
    // Exclure les lignes "(global)" du stats_classes pour le compteur classes
    if (excludeGlobal && row.isGlobal) continue;

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

function countPupils(licenceDir) {
  const pupilsFile = path.join(licenceDir, '_pupils', 'all_pupils.json');
  if (!fs.existsSync(pupilsFile)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(pupilsFile, 'utf8'));
    return data.count || (data.rows ? data.rows.length : 0);
  } catch { return 0; }
}

function extractNotesDetails(rows) {
  // Extraire matières uniques, périodes uniques depuis les rows fusionnés de notes
  if (!rows) return { nbMatieres: 0, nbPeriodes: 0, matieres: [], periodes: [] };
  const matieres = new Set();
  const periodes = new Set();
  for (const row of rows) {
    if (row.matiere) matieres.add(row.matiere);
    if (row.periode) periodes.add(row.periode);
  }
  return {
    nbMatieres: matieres.size,
    nbPeriodes: periodes.size,
    matieres: [...matieres].sort(),
    periodes: [...periodes].sort(),
  };
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
    totalEleves: 0,
    totalMatieres: 0,
    totalPeriodes: 0,
    totalEntries: { notes: 0, assiduite: 0, classes: 0, pupils: 0 },
    globalMatieres: new Set(),
    globalPeriodes: new Set(),
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

      // Élèves
      const nbEleves = countPupils(lic.path);
      data.totalEleves += nbEleves;

      // Per-scraper stats — fusionner original + tous les retries
      const scraperStats = {};
      let notesDetails = { nbMatieres: 0, nbPeriodes: 0, matieres: [], periodes: [] };
      for (const scraper of SCRAPER_TYPES) {
        const statsPaths = findAllStatsFiles(lic.path, scraper);
        const rows = await readAndMergeStatsFiles(statsPaths);
        const agg = aggregateStats(rows, scraper === 'classes');
        scraperStats[scraper] = agg;

        // Extraire matières et périodes depuis les notes
        if (scraper === 'notes' && rows) {
          notesDetails = extractNotesDetails(rows);
          // Accumuler dans les sets globaux
          notesDetails.matieres.forEach(m => data.globalMatieres.add(m));
          notesDetails.periodes.forEach(p => data.globalPeriodes.add(p));
        }

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
        nbEleves,
        nbMatieres: notesDetails.nbMatieres,
        nbPeriodes: notesDetails.nbPeriodes,
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

  // Finaliser les totaux globaux
  data.totalMatieres = data.globalMatieres.size;
  data.totalPeriodes = data.globalPeriodes.size;
  delete data.globalMatieres; // Set n'est pas sérialisable
  delete data.globalPeriodes;

  // Write JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✅ ${OUTPUT_FILE} généré`);
  console.log(`   ${data.summary.total} licences: ${data.summary.done} done, ${data.summary.skip} skip, ${data.summary.inProgress} en cours`);
  console.log(`   ${data.totalClasses} classes | ${data.totalEleves} élèves | ${data.totalMatieres} matières | ${data.totalPeriodes} périodes`);
}

main().catch(err => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});

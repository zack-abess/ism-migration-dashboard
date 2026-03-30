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
const IGNORE_DIRS = new Set(['_debug', '_notes', '_assiduite', '_pupils', '_global']);

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

function readPupilIds(licenceDir) {
  // Retourne un tableau d'identifiants élèves pour le calcul de doublons
  const pupilsFile = path.join(licenceDir, '_pupils', 'all_pupils.json');
  if (!fs.existsSync(pupilsFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(pupilsFile, 'utf8'));
    if (!data.rows) return [];
    return data.rows.map(r => (r.Identifiant || '').trim()).filter(Boolean);
  } catch { return []; }
}

function readGlobalData(licenceDir) {
  // Lit les fichiers _global/ pour extraire enseignants et matières globales
  const globalDir = path.join(licenceDir, '_global');
  const result = { teachers: [], fields: [] };
  if (!fs.existsSync(globalDir)) return result;

  // Teachers
  const teachFile = path.join(globalDir, 'teachers.json');
  if (fs.existsSync(teachFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(teachFile, 'utf8'));
      const rows = Array.isArray(data) ? data : (data.rows || []);
      for (const r of rows) {
        const nom = ((r['Professeur'] || '') + ' ' + (r['Prénom'] || '')).trim();
        if (nom && nom !== 'Professeur') result.teachers.push(nom);
      }
    } catch {}
  }

  // Fields (matières globales)
  const fieldFile = path.join(globalDir, 'fields.json');
  if (fs.existsSync(fieldFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(fieldFile, 'utf8'));
      const rows = Array.isArray(data) ? data : (data.rows || []);
      for (const r of rows) {
        const nom = (r['Matière'] || '').trim();
        if (nom && nom !== 'Matière') result.fields.push(nom);
      }
    } catch {}
  }

  return result;
}

// ─── Données métier (onglet Groupe ISM) ────────────────────────────────────

function readPupilsDetailed(licenceDir) {
  // Lit all_pupils.json et retourne les détails démographiques
  const pupilsFile = path.join(licenceDir, '_pupils', 'all_pupils.json');
  if (!fs.existsSync(pupilsFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(pupilsFile, 'utf8'));
    if (!data.rows) return [];
    return data.rows.map(r => ({
      id: (r.Identifiant || '').trim(),
      sexe: (r.Sexe || '').trim(),
      nationalite: (r.Nationalité || r['Nationalite'] || '').trim(),
      dateNaissance: (r['Date de naissance'] || '').trim(),
      niveau: (r.Niveau || '').trim(),
      redoublant: (r.Redoublant || '').trim().toLowerCase() === 'oui',
      boursier: (r.Boursier || '').trim().toLowerCase() === 'oui',
      exempt: (r['Exempt des frais'] || '').trim().toLowerCase() === 'oui',
      classe: (r.Classe || '').trim(),
    }));
  } catch { return []; }
}

function readClassFields(licenceDir) {
  // Lit class_fields.json dans chaque classe pour les coefficients, crédits, UE
  if (!fs.existsSync(licenceDir)) return [];
  const results = [];
  try {
    const classDirs = fs.readdirSync(licenceDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'));
    for (const cd of classDirs) {
      const cfPath = path.join(licenceDir, cd.name, 'class_fields.json');
      if (!fs.existsSync(cfPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(cfPath, 'utf8'));
        const rows = Array.isArray(data) ? data : (data.rows || []);
        for (const r of rows) {
          results.push({
            classe: cd.name,
            matiere: (r['Matière'] || '').trim(),
            ue: (r['U.E.'] || '').trim(),
            coefficient: parseFloat(r['Coefficient']) || 0,
            credits: parseFloat(r['Crédits'] || r['Credits']) || 0,
            bareme: parseFloat(r['Barème'] || r['Bareme']) || 20,
            option: (r['Option'] || '').trim().toLowerCase() === 'oui',
          });
        }
      } catch {}
    }
  } catch {}
  return results;
}

function readGradesForLicence(licenceDir) {
  // Lit tous les fichiers de notes dans _notes/ et retourne les moyennes
  const notesDir = path.join(licenceDir, '_notes');
  if (!fs.existsSync(notesDir)) return [];
  const grades = [];
  try {
    // _notes/ contient des sous-dossiers par classe
    const classDirs = fs.readdirSync(notesDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const cd of classDirs) {
      const classNotesDir = path.join(notesDir, cd.name);
      // Chaque sous-dossier contient des JSON de périodes ou matières
      const files = fs.readdirSync(classNotesDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(classNotesDir, f), 'utf8'));
          if (!data.rows || !data.headers) continue;
          const bareme = data.barème || data.bareme || 20;
          // Trouver les colonnes de notes dans headers
          const noteHeaders = (data.headers || []).filter(h =>
            h !== 'Elève' && h !== 'Élève' && h !== '#' && h !== '_db_ids' && h !== '_links'
          );
          for (const row of data.rows) {
            for (const h of noteHeaders) {
              const val = parseFloat(row[h]);
              if (!isNaN(val) && val >= 0 && val <= bareme) {
                grades.push({
                  classe: data.className || cd.name,
                  periode: data.periodName || '',
                  matiere: data.fieldName || '',
                  note: val,
                  bareme,
                  note20: bareme !== 20 ? (val / bareme * 20) : val,
                  type: h, // CC, Examen, etc.
                });
              }
            }
          }
        } catch {}
      }
    }
  } catch {}
  return grades;
}

function readAttendanceForLicence(licenceDir) {
  // Lit les fichiers d'assiduité dans _assiduite/
  const assDir = path.join(licenceDir, '_assiduite');
  if (!fs.existsSync(assDir)) return [];
  const records = [];
  try {
    const classDirs = fs.readdirSync(assDir, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const cd of classDirs) {
      const classAssDir = path.join(assDir, cd.name);
      const files = fs.readdirSync(classAssDir).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(classAssDir, f), 'utf8'));
          if (!data.rows) continue;
          for (const row of data.rows) {
            const absences = parseFloat(row.absences || row['absences'] || 0) || 0;
            const justifiees = parseFloat(row['absences justifiées'] || row['absences justifiees'] || 0) || 0;
            if (absences > 0 || justifiees > 0) {
              records.push({
                classe: data.className || cd.name,
                periode: data.periodName || '',
                absences,
                justifiees,
                nonJustifiees: absences - justifiees,
              });
            }
          }
        } catch {}
      }
    }
  } catch {}
  return records;
}

function readClassMainInfo(licenceDir) {
  // Lit main.json de chaque classe pour niveau, filière, domaine
  if (!fs.existsSync(licenceDir)) return [];
  const results = [];
  try {
    const classDirs = fs.readdirSync(licenceDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'));
    for (const cd of classDirs) {
      const mainPath = path.join(licenceDir, cd.name, 'main.json');
      if (!fs.existsSync(mainPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
        results.push({
          classe: cd.name,
          niveau: (data.level || data.niveau || '').trim(),
          gradeType: (data.gradeType || '').trim(),
          area: (data.academicArea || data.area || '').trim(),
          program: (data.program || '').trim(),
        });
      } catch {}
    }
  } catch {}
  return results;
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
    totalEnseignants: 0,
    totalEntries: { notes: 0, assiduite: 0, classes: 0, pupils: 0 },
    // Uniques vs doublons
    uniqueEleves: 0,
    uniqueEnseignants: 0,
    uniqueMatieresGlobal: 0,
    // Sets temporaires (non sérialisés)
    _globalMatieres: new Set(),
    _globalPeriodes: new Set(),
    _allEleveIds: new Set(),
    _allTeachers: new Set(),
    _allFieldsGlobal: new Set(),
    _rawEleveCount: 0,
    _rawTeacherCount: 0,
    _rawFieldCount: 0,
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

      // Identifiants élèves pour doublons
      const pupilIds = readPupilIds(lic.path);
      data._rawEleveCount += pupilIds.length;
      pupilIds.forEach(id => data._allEleveIds.add(id));

      // Données globales (enseignants, matières globales)
      const globalData = readGlobalData(lic.path);
      data._rawTeacherCount += globalData.teachers.length;
      globalData.teachers.forEach(t => data._allTeachers.add(t.toLowerCase()));
      data._rawFieldCount += globalData.fields.length;
      globalData.fields.forEach(f => data._allFieldsGlobal.add(f.toLowerCase()));

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
          notesDetails.matieres.forEach(m => data._globalMatieres.add(m));
          notesDetails.periodes.forEach(p => data._globalPeriodes.add(p));
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
        nbEnseignants: globalData.teachers.length,
        nbMatieres: notesDetails.nbMatieres,
        nbMatieresGlobal: globalData.fields.length,
        nbPeriodes: notesDetails.nbPeriodes,
        lastModified,
        scrapers: scraperStats,
        _path: lic.path,
      };

      data.licences.push(licenceData);
      data.totalClasses += nbClasses;

      // Schools aggregation
      if (!data.schools[school]) {
        data.schools[school] = {
          years: [], doneCount: 0, skipCount: 0, inProgressCount: 0,
          nbClasses: 0, nbEleves: 0, nbEnseignants: 0,
          scrapers: {
            notes:     { ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, total: 0, totalEntries: 0 },
            assiduite: { ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, total: 0, totalEntries: 0 },
            classes:   { ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, total: 0, totalEntries: 0 },
            pupils:    { ok: 0, empty: 0, error: 0, noperiod: 0, nofield: 0, total: 0, totalEntries: 0 },
          },
        };
      }
      const s = data.schools[school];
      s.years.push(year);
      s.nbClasses += nbClasses;
      s.nbEleves += nbEleves;
      s.nbEnseignants += globalData.teachers.length;
      if (cat.status === 'done') s.doneCount++;
      if (cat.status === 'skip') s.skipCount++;
      if (cat.status === 'in_progress') s.inProgressCount++;

      // Agréger les stats scrapers par école
      for (const scraper of SCRAPER_TYPES) {
        const st = scraperStats[scraper];
        const schoolSt = s.scrapers[scraper];
        schoolSt.ok += st.ok;
        schoolSt.empty += st.empty;
        schoolSt.error += st.error;
        schoolSt.noperiod += st.noperiod;
        schoolSt.nofield += st.nofield;
        schoolSt.total += st.total;
        schoolSt.totalEntries += st.totalEntries;
      }

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
  data.totalMatieres = data._globalMatieres.size;
  data.totalPeriodes = data._globalPeriodes.size;
  data.uniqueEleves = data._allEleveIds.size;
  data.uniqueEnseignants = data._allTeachers.size;
  data.uniqueMatieresGlobal = data._allFieldsGlobal.size;
  data.totalEnseignants = data._rawTeacherCount;

  // Doublons = total - uniques
  data.doublons = {
    eleves: data._rawEleveCount - data._allEleveIds.size,
    enseignants: data._rawTeacherCount - data._allTeachers.size,
    matieresGlobal: data._rawFieldCount - data._allFieldsGlobal.size,
  };

  // ─── Données métier (onglet Groupe ISM) ───────────────────────────────
  console.log('📈 Extraction des données métier...');
  const businessData = {
    effectifs: {},
    demographics: {
      sexe: { M: 0, F: 0, inconnu: 0 },
      boursiers: 0, redoublants: 0, exempts: 0, totalPupils: 0,
      nationalites: {},
      ages: {},
      niveaux: {},
      sexeParEcole: {},
      boursiersParEcole: {},
      redoublantsParEcole: {},
    },
    academic: {
      moyenneGlobale: 0, totalNotes: 0,
      moyenneParEcole: {},
      tauxReussite: {},
      topMatieres: {},
      ccVsExam: { cc: { sum: 0, count: 0 }, exam: { sum: 0, count: 0 } },
    },
    attendance: {
      totalAbsences: 0, totalJustifiees: 0, totalNonJustifiees: 0,
      absencesParEcole: {},
    },
    structure: {
      niveauxDistrib: {},
      filieresDistrib: {},
    },
  };

  let totalGradesSum = 0, totalGradesCount = 0;

  for (const lic of data.licences) {
    const { school, year } = lic;
    const licDir = lic._path;
    if (!licDir) continue;

    // Effectifs par école par année
    if (!businessData.effectifs[school]) businessData.effectifs[school] = {};
    businessData.effectifs[school][year] = (businessData.effectifs[school][year] || 0) + lic.nbEleves;

    // Démographie
    const pupils = readPupilsDetailed(licDir);
    const seenIds = new Set();
    for (const p of pupils) {
      if (seenIds.has(p.id)) continue;
      seenIds.add(p.id);
      businessData.demographics.totalPupils++;

      if (p.sexe.startsWith('M') && !p.sexe.startsWith('Ma')) businessData.demographics.sexe.M++;
      else if (p.sexe.startsWith('F') || p.sexe.startsWith('Fém')) businessData.demographics.sexe.F++;
      else businessData.demographics.sexe.inconnu++;

      if (!businessData.demographics.sexeParEcole[school]) businessData.demographics.sexeParEcole[school] = { M: 0, F: 0 };
      if (p.sexe.startsWith('M') && !p.sexe.startsWith('Ma')) businessData.demographics.sexeParEcole[school].M++;
      else if (p.sexe.startsWith('F') || p.sexe.startsWith('Fém')) businessData.demographics.sexeParEcole[school].F++;

      if (p.boursier) {
        businessData.demographics.boursiers++;
        businessData.demographics.boursiersParEcole[school] = (businessData.demographics.boursiersParEcole[school] || 0) + 1;
      }
      if (p.redoublant) {
        businessData.demographics.redoublants++;
        businessData.demographics.redoublantsParEcole[school] = (businessData.demographics.redoublantsParEcole[school] || 0) + 1;
      }
      if (p.exempt) businessData.demographics.exempts++;

      if (p.nationalite) {
        businessData.demographics.nationalites[p.nationalite] = (businessData.demographics.nationalites[p.nationalite] || 0) + 1;
      }

      if (p.dateNaissance) {
        const parts = p.dateNaissance.split('/');
        let birthYear = null;
        if (parts.length === 3) birthYear = parseInt(parts[2]);
        else if (parts.length === 1) birthYear = parseInt(parts[0]);
        if (birthYear && birthYear > 1950 && birthYear < 2015) {
          const age = 2025 - birthYear;
          const tranche = age < 18 ? '<18' : age <= 20 ? '18-20' : age <= 23 ? '21-23' : age <= 25 ? '24-25' : age <= 30 ? '26-30' : '>30';
          businessData.demographics.ages[tranche] = (businessData.demographics.ages[tranche] || 0) + 1;
        }
      }

      if (p.niveau) {
        businessData.demographics.niveaux[p.niveau] = (businessData.demographics.niveaux[p.niveau] || 0) + 1;
      }
    }

    // Notes
    const grades = readGradesForLicence(licDir);
    if (grades.length > 0) {
      if (!businessData.academic.moyenneParEcole[school]) businessData.academic.moyenneParEcole[school] = { sum: 0, count: 0 };
      if (!businessData.academic.tauxReussite[school]) businessData.academic.tauxReussite[school] = { reussi: 0, total: 0 };
      for (const g of grades) {
        totalGradesSum += g.note20;
        totalGradesCount++;
        businessData.academic.moyenneParEcole[school].sum += g.note20;
        businessData.academic.moyenneParEcole[school].count++;
        businessData.academic.tauxReussite[school].total++;
        if (g.note20 >= 10) businessData.academic.tauxReussite[school].reussi++;

        if (g.matiere) {
          if (!businessData.academic.topMatieres[g.matiere]) businessData.academic.topMatieres[g.matiere] = { sum: 0, count: 0 };
          businessData.academic.topMatieres[g.matiere].sum += g.note20;
          businessData.academic.topMatieres[g.matiere].count++;
        }

        const typeLower = (g.type || '').toLowerCase();
        if (typeLower.includes('continu') || typeLower === 'cc' || typeLower.includes('contrôle')) {
          businessData.academic.ccVsExam.cc.sum += g.note20;
          businessData.academic.ccVsExam.cc.count++;
        } else if (typeLower.includes('exam') || typeLower.includes('partiel')) {
          businessData.academic.ccVsExam.exam.sum += g.note20;
          businessData.academic.ccVsExam.exam.count++;
        }
      }
    }

    // Assiduité
    const attendance = readAttendanceForLicence(licDir);
    if (attendance.length > 0) {
      if (!businessData.attendance.absencesParEcole[school]) businessData.attendance.absencesParEcole[school] = { absences: 0, justifiees: 0, records: 0 };
      for (const a of attendance) {
        businessData.attendance.totalAbsences += a.absences;
        businessData.attendance.totalJustifiees += a.justifiees;
        businessData.attendance.totalNonJustifiees += a.nonJustifiees;
        businessData.attendance.absencesParEcole[school].absences += a.absences;
        businessData.attendance.absencesParEcole[school].justifiees += a.justifiees;
        businessData.attendance.absencesParEcole[school].records++;
      }
    }

    // Structure
    const classInfos = readClassMainInfo(licDir);
    for (const ci of classInfos) {
      if (ci.niveau) businessData.structure.niveauxDistrib[ci.niveau] = (businessData.structure.niveauxDistrib[ci.niveau] || 0) + 1;
      if (ci.area) businessData.structure.filieresDistrib[ci.area] = (businessData.structure.filieresDistrib[ci.area] || 0) + 1;
    }
  }

  // Calculs finaux
  businessData.academic.moyenneGlobale = totalGradesCount > 0 ? +(totalGradesSum / totalGradesCount).toFixed(2) : 0;
  businessData.academic.totalNotes = totalGradesCount;
  for (const d of Object.values(businessData.academic.moyenneParEcole)) {
    d.moy = d.count > 0 ? +(d.sum / d.count).toFixed(2) : 0;
  }
  for (const d of Object.values(businessData.academic.tauxReussite)) {
    d.taux = d.total > 0 ? +(d.reussi / d.total * 100).toFixed(1) : 0;
  }
  // Top 20 matières
  businessData.academic.topMatieres = Object.entries(businessData.academic.topMatieres)
    .map(([m, d]) => ({ matiere: m, moy: +(d.sum / d.count).toFixed(2), count: d.count }))
    .sort((a, b) => b.count - a.count).slice(0, 20);
  // CC vs Exam
  const cc = businessData.academic.ccVsExam.cc;
  const ex = businessData.academic.ccVsExam.exam;
  businessData.academic.ccVsExam = {
    cc: { moy: cc.count > 0 ? +(cc.sum / cc.count).toFixed(2) : 0, count: cc.count },
    exam: { moy: ex.count > 0 ? +(ex.sum / ex.count).toFixed(2) : 0, count: ex.count },
  };

  data.business = businessData;
  console.log(`   📈 Démographie: ${businessData.demographics.totalPupils} élèves analysés | ${totalGradesCount} notes | ${businessData.attendance.totalAbsences} absences`);

  // Nettoyage des sets temporaires (non sérialisables)
  delete data._globalMatieres;
  delete data._globalPeriodes;
  delete data._allEleveIds;
  delete data._allTeachers;
  delete data._allFieldsGlobal;
  delete data._rawEleveCount;
  delete data._rawTeacherCount;
  delete data._rawFieldCount;
  data.licences.forEach(l => delete l._path);

  // Write JSON
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✅ ${OUTPUT_FILE} généré`);
  console.log(`   ${data.summary.total} licences: ${data.summary.done} done, ${data.summary.skip} skip, ${data.summary.inProgress} en cours`);
  console.log(`   ${data.totalClasses} classes | ${data.totalEleves} élèves (${data.uniqueEleves} uniques) | ${data.totalEnseignants} enseignants (${data.uniqueEnseignants} uniques)`);
  console.log(`   ${data.totalMatieres} matières notes | ${data.uniqueMatieresGlobal} matières globales uniques | ${data.totalPeriodes} périodes`);
}

main().catch(err => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});

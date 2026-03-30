const fs = require('fs');
const path = require('path');

const BASE_PATH = '/sessions/peaceful-fervent-hawking/mnt/schoolArt/scraper-classexpert-v2';
const DONE_DIR = path.join(BASE_PATH, 'Done');
const SKIP_DIR = path.join(BASE_PATH, 'Skip');

// Helper: normalize string for comparison
function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Helper: strip accents
function stripAccents(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Helper: calculate age from DD/MM/YYYY and year
function getAge(dateStr, yearInt) {
  if (!dateStr || !yearInt) return null;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return null;
  const d = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  if (isNaN(d.getTime())) return null;
  return yearInt - d.getFullYear();
}

// Helper: extract year from licence path like "ISM_Dakar_Ecole_d'Ingénieurs_2017-2018"
function extractYearFromPath(licPath) {
  const match = licPath.match(/(\d{4})-(\d{4})$/);
  if (match) return parseInt(match[2]);
  return null;
}

// Helper: check if email is malformed
function isMalformedEmail(email) {
  if (!email) return false;
  return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Main audit function
function generateAuditData() {
  const audit = {
    generatedAt: new Date().toISOString(),
    summary: { totalIssues: 0, critical: 0, warning: 0, info: 0 },
    matieres: {
      totalOccurrences: 0,
      uniqueCount: 0,
      duplicateGroups: [],
      emptyCoefficient: 0,
      emptyBareme: 0,
      emptyCredits: 0,
      emptyProfesseur: 0,
      emptyUE: 0,
      percentEmptyUE: 0
    },
    periodes: {
      totalUnique: new Set(),
      anomalies: [],
      toDelete: [],
      placeholders: []
    },
    notes: {
      totalFiles: 0,
      populatedFiles: 0,
      emptyFiles: 0,
      uniformGrades: []
    },
    eleves: {
      completude: {
        nom: { filled: 0, total: 0, pct: 0 },
        sexe: { filled: 0, total: 0, pct: 0 },
        dateNaissance: { filled: 0, total: 0, pct: 0 },
        nationalite: { filled: 0, total: 0, pct: 0 },
        email: { filled: 0, total: 0, pct: 0 },
        telephone: { filled: 0, total: 0, pct: 0 },
        identifiant: { filled: 0, total: 0, pct: 0 }
      },
      suspiciousDOB: [],
      malformedEmails: 0,
      duplicateIds: 0
    },
    classes: {
      totalClasses: 0,
      administrative: [],
      emptyClasses: 0
    },
    ue: {
      totalOccurrences: 0,
      uniqueCount: 0,
      emptyCount: 0,
      duplicateGroups: []
    }
  };

  const allDirs = [];
  for (const dir of [DONE_DIR, SKIP_DIR]) {
    if (!fs.existsSync(dir)) continue;
    const schools = fs.readdirSync(dir);
    for (const school of schools) {
      const schoolPath = path.join(dir, school);
      if (!fs.statSync(schoolPath).isDirectory()) continue;
      allDirs.push({ school, schoolPath });
    }
  }

  let matiereMap = {};
  let ueMap = {};
  const emailSet = new Set();
  const idSet = new Set();
  let duplicateIdCount = 0;
  const allEmails = [];

  // Scan all licences
  for (const { school, schoolPath } of allDirs) {
    const licences = fs.readdirSync(schoolPath);
    for (const licence of licences) {
      const licPath = path.join(schoolPath, licence);
      if (!fs.statSync(licPath).isDirectory()) continue;

      const classFieldsPath = path.join(licPath, 'class_fields.json');
      if (!fs.existsSync(classFieldsPath)) continue;

      const classFieldsData = JSON.parse(fs.readFileSync(classFieldsPath, 'utf-8'));
      const rows = classFieldsData.rows || [];

      // Analyze matières
      for (const row of rows) {
        const matiere = row['Matière'] || '';
        const ue = row['U.E.'] || '';
        const coef = row['Coefficient'] || '';
        const barreme = row['Barème'] || '';
        const credits = row['Crédits'] || '';
        const prof = row['Professeur'] || '';

        if (matiere) {
          audit.matieres.totalOccurrences++;
          const norm = normalize(matiere);
          if (!matiereMap[norm]) {
            matiereMap[norm] = { canonical: stripAccents(matiere), variants: {} };
          }
          matiereMap[norm].variants[matiere] = (matiereMap[norm].variants[matiere] || 0) + 1;
        }

        if (ue) {
          audit.ue.totalOccurrences++;
          const norm = normalize(ue);
          if (!ueMap[norm]) {
            ueMap[norm] = { canonical: stripAccents(ue), variants: {} };
          }
          ueMap[norm].variants[ue] = (ueMap[norm].variants[ue] || 0) + 1;
        } else {
          audit.matieres.emptyUE++;
        }

        if (!coef) audit.matieres.emptyCoefficient++;
        if (!barreme) audit.matieres.emptyBareme++;
        if (!credits) audit.matieres.emptyCredits++;
        if (!prof) audit.matieres.emptyProfesseur++;
      }

      // Check periods
      const periodsPath = path.join(schoolPath, '_global', 'periods.json');
      if (fs.existsSync(periodsPath)) {
        const periodsData = JSON.parse(fs.readFileSync(periodsPath, 'utf-8'));
        const periods = periodsData.rows || [];
        const periodNames = periods.map(p => p['Période'] || '');
        const uniquePeriods = new Set(periodNames);
        audit.periodes.totalUnique = new Set([...audit.periodes.totalUnique, ...uniquePeriods]);

        // Check for anomalies
        if (periodNames.length !== 12) {
          audit.periodes.anomalies.push({
            licence: licence,
            school: school,
            year: extractYearFromPath(licPath),
            periodCount: periodNames.length,
            expected: 12,
            issue: periodNames.length > 12 ? 'excess' : 'deficit'
          });
        }

        // Check for markers
        for (const p of periods) {
          const name = p['Période'] || '';
          if (name.includes('A supprimer')) audit.periodes.toDelete.push(name);
          if (name.includes('XXXX')) audit.periodes.placeholders.push(name);
        }
      }

      // Check notes
      const notesPath = path.join(schoolPath, '_notes', licence);
      if (fs.existsSync(notesPath)) {
        const periods = fs.readdirSync(notesPath);
        for (const period of periods) {
          const periodPath = path.join(notesPath, period);
          if (!fs.statSync(periodPath).isDirectory()) continue;

          const files = fs.readdirSync(periodPath).filter(f => f.endsWith('.json'));
          for (const file of files) {
            const filePath = path.join(periodPath, file);
            const notesData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const notesRows = notesData.rows || [];

            audit.notes.totalFiles++;
            if (notesRows.length === 0) {
              audit.notes.emptyFiles++;
            } else {
              audit.notes.populatedFiles++;

              // Check for uniform grades
              const ccValues = notesRows.map(r => r['Contrôle Continu']).filter(v => v);
              const exValues = notesRows.map(r => r['Examen']).filter(v => v);

              const ccUniform = ccValues.length > 0 && new Set(ccValues).size === 1;
              const exUniform = exValues.length > 0 && new Set(exValues).size === 1;

              if ((ccUniform || exUniform) && notesRows.length > 1) {
                audit.notes.uniformGrades.push({
                  licence: licence,
                  classe: notesData.className || '',
                  matiere: notesData.fieldName || file,
                  grade: ccUniform ? ccValues[0] : exValues[0],
                  studentCount: notesRows.length,
                  type: ccUniform ? 'CC' : 'Exam'
                });
              }
            }
          }
        }
      }

      // Check pupils
      const pupilsPath = path.join(licPath, 'pupils.json');
      if (fs.existsSync(pupilsPath)) {
        const pupilsData = JSON.parse(fs.readFileSync(pupilsPath, 'utf-8'));
        const pupils = pupilsData.rows || [];
        const year = extractYearFromPath(licPath);

        audit.classes.totalClasses++;
        if (pupils.length === 0) {
          audit.classes.emptyClasses++;
        }

        for (const pupil of pupils) {
          // Completude
          audit.eleves.completude.nom.total++;
          if (pupil['Nom']) audit.eleves.completude.nom.filled++;

          audit.eleves.completude.sexe.total++;
          if (pupil['Sexe']) audit.eleves.completude.sexe.filled++;

          audit.eleves.completude.dateNaissance.total++;
          if (pupil['Date de naissance']) audit.eleves.completude.dateNaissance.filled++;

          audit.eleves.completude.nationalite.total++;
          if (pupil['Nationalité']) audit.eleves.completude.nationalite.filled++;

          audit.eleves.completude.email.total++;
          if (pupil['E-mail']) audit.eleves.completude.email.filled++;

          audit.eleves.completude.telephone.total++;
          if (pupil['Téléphone']) audit.eleves.completude.telephone.filled++;

          audit.eleves.completude.identifiant.total++;
          if (pupil['Identifiant']) audit.eleves.completude.identifiant.filled++;

          // Suspicious DOB
          if (pupil['Date de naissance']) {
            const age = getAge(pupil['Date de naissance'], year);
            if (age !== null && (age < 15 || age > 50)) {
              audit.eleves.suspiciousDOB.push({
                eleve: pupil['Elève'] || '',
                dob: pupil['Date de naissance'],
                classe: licence,
                licence: school,
                issue: age < 15 ? 'too young' : age > 50 ? 'too old' : 'future'
              });
            }
          }

          // Email checks
          const email = pupil['E-mail'] || '';
          if (email && isMalformedEmail(email)) {
            audit.eleves.malformedEmails++;
          }
          if (email) {
            allEmails.push(email);
            if (emailSet.has(email)) {
              duplicateIdCount++;
            }
            emailSet.add(email);
          }

          // ID checks
          const id = pupil['Identifiant'] || '';
          if (id) {
            if (idSet.has(id)) {
              duplicateIdCount++;
            }
            idSet.add(id);
          }
        }
      }

      // Check for administrative classes
      if (licence.toUpperCase().includes('ADMIN') || licence.toUpperCase().includes('NON_INSCRIT')) {
        audit.classes.administrative.push(licence);
      }
    }
  }

  // Calculate percentages
  for (const field of ['nom', 'sexe', 'dateNaissance', 'nationalite', 'email', 'telephone', 'identifiant']) {
    if (audit.eleves.completude[field].total > 0) {
      audit.eleves.completude[field].pct = Math.round(
        (audit.eleves.completude[field].filled / audit.eleves.completude[field].total) * 100
      );
    }
  }

  // Build matière groups
  const matiereDups = [];
  for (const [norm, data] of Object.entries(matiereMap)) {
    const variants = Object.entries(data.variants).map(([name, count]) => ({ name, count }));
    if (variants.length > 1) {
      const totalCount = variants.reduce((sum, v) => sum + v.count, 0);
      matiereDups.push({
        canonical: data.canonical,
        variants: variants.sort((a, b) => b.count - a.count),
        totalCount
      });
    }
  }
  matiereDups.sort((a, b) => b.totalCount - a.totalCount);
  audit.matieres.duplicateGroups = matiereDups.slice(0, 100);
  audit.matieres.uniqueCount = Object.keys(matiereMap).length;

  // Build UE groups
  const ueDups = [];
  for (const [norm, data] of Object.entries(ueMap)) {
    const variants = Object.entries(data.variants).map(([name, count]) => ({ name, count }));
    if (variants.length > 1) {
      ueDups.push({
        canonical: data.canonical,
        variants: variants.sort((a, b) => b.count - a.count)
      });
    }
  }
  ueDups.sort((a, b) =>
    b.variants.reduce((s, v) => s + v.count, 0) - a.variants.reduce((s, v) => s + v.count, 0)
  );
  audit.ue.duplicateGroups = ueDups.slice(0, 100);
  audit.ue.uniqueCount = Object.keys(ueMap).length;

  // Calculate percent empty UE
  if (audit.matieres.totalOccurrences > 0) {
    audit.matieres.percentEmptyUE = Math.round(
      (audit.matieres.emptyUE / audit.matieres.totalOccurrences) * 100
    );
  }

  // Convert totalUnique to number
  audit.periodes.totalUnique = audit.periodes.totalUnique.size;

  // Sort and limit arrays
  audit.notes.uniformGrades = audit.notes.uniformGrades.sort((a, b) => b.studentCount - a.studentCount).slice(0, 50);
  audit.eleves.suspiciousDOB = audit.eleves.suspiciousDOB.slice(0, 50);
  audit.periodes.anomalies = audit.periodes.anomalies.slice(0, 50);

  // Remove duplicates from toDelete and placeholders
  audit.periodes.toDelete = [...new Set(audit.periodes.toDelete)];
  audit.periodes.placeholders = [...new Set(audit.periodes.placeholders)];

  // Count issues for summary
  audit.eleves.duplicateIds = duplicateIdCount;

  const criticalCount =
    audit.matieres.emptyUE +
    audit.notes.emptyFiles +
    audit.eleves.malformedEmails +
    audit.eleves.duplicateIds +
    audit.classes.emptyClasses;

  const warningCount =
    audit.matieres.emptyCoefficient +
    audit.matieres.emptyBareme +
    audit.matieres.emptyCredits +
    audit.matieres.emptyProfesseur +
    audit.periodes.anomalies.length +
    audit.eleves.suspiciousDOB.length;

  const infoCount =
    audit.matieres.duplicateGroups.length +
    audit.ue.duplicateGroups.length +
    audit.periodes.toDelete.length +
    audit.periodes.placeholders.length;

  audit.summary.critical = criticalCount;
  audit.summary.warning = warningCount;
  audit.summary.info = infoCount;
  audit.summary.totalIssues = criticalCount + warningCount + infoCount;

  return audit;
}

// Main
const audit = generateAuditData();
const outputPath = path.join(BASE_PATH, 'dashboard', 'audit-data.json');
fs.writeFileSync(outputPath, JSON.stringify(audit, null, 2));

console.log('Audit data generated successfully');
console.log(`Output: ${outputPath}`);
console.log(`Total issues: ${audit.summary.totalIssues} (${audit.summary.critical} critical, ${audit.summary.warning} warnings, ${audit.summary.info} info)`);

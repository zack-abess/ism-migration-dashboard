#!/usr/bin/env python3
"""
Génère un rapport PDF mensuel à partir de dashboard-data.json
Usage: python3 dashboard/generate_report_pdf.py
"""
import json, os, sys
from datetime import datetime
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm, mm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, HRFlowable
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(SCRIPT_DIR, 'dashboard-data.json')
OUTPUT_FILE = os.path.join(SCRIPT_DIR, 'rapport_groupe_ism.pdf')

# Couleurs
BLUE = HexColor('#3b82f6')
GREEN = HexColor('#22c55e')
RED = HexColor('#ef4444')
ORANGE = HexColor('#f97316')
GRAY = HexColor('#64748b')
DARK = HexColor('#1e293b')
LIGHT = HexColor('#f1f5f9')
WHITE = HexColor('#ffffff')

def fmt(n):
    if n is None: return '—'
    return f"{n:,.0f}".replace(',', ' ')

def pct(a, b):
    if b == 0: return '0%'
    return f"{a/b*100:.1f}%"

def build_pdf(data):
    doc = SimpleDocTemplate(OUTPUT_FILE, pagesize=A4,
        topMargin=2*cm, bottomMargin=2*cm, leftMargin=2*cm, rightMargin=2*cm)

    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle('MainTitle', parent=styles['Title'], fontSize=22, textColor=BLUE, spaceAfter=6))
    styles.add(ParagraphStyle('Subtitle', parent=styles['Normal'], fontSize=11, textColor=GRAY, alignment=TA_CENTER, spaceAfter=20))
    styles.add(ParagraphStyle('SectionTitle', parent=styles['Heading1'], fontSize=14, textColor=BLUE, spaceBefore=20, spaceAfter=10))
    styles.add(ParagraphStyle('SubSection', parent=styles['Heading2'], fontSize=11, textColor=DARK, spaceBefore=14, spaceAfter=8))
    styles.add(ParagraphStyle('Body', parent=styles['Normal'], fontSize=9.5, leading=13, spaceAfter=6))
    styles.add(ParagraphStyle('Small', parent=styles['Normal'], fontSize=8, textColor=GRAY, spaceAfter=4))
    styles.add(ParagraphStyle('KpiValue', parent=styles['Normal'], fontSize=16, textColor=BLUE, alignment=TA_CENTER, fontName='Helvetica-Bold'))
    styles.add(ParagraphStyle('KpiLabel', parent=styles['Normal'], fontSize=8, textColor=GRAY, alignment=TA_CENTER))

    story = []
    B = data.get('business', {})
    D = B.get('demographics', {})
    A = B.get('academic', {})
    AT = B.get('attendance', {})
    Q = B.get('quality', {})
    P = B.get('palmares', {})
    PR = B.get('projections', {})

    now = datetime.now().strftime('%d/%m/%Y')

    # ═══ PAGE 1: COUVERTURE + RÉSUMÉ ═══
    story.append(Spacer(1, 3*cm))
    story.append(Paragraph('Groupe ISM', styles['MainTitle']))
    story.append(Paragraph('Rapport de migration ClassExpert — Symfony SI', styles['Subtitle']))
    story.append(Paragraph(f'Généré le {now}', styles['Small']))
    story.append(Spacer(1, 2*cm))
    story.append(HRFlowable(width="80%", color=BLUE, thickness=2))
    story.append(Spacer(1, 1*cm))

    # Résumé exécutif
    s = data.get('summary', {})
    total_eleves = data.get('totalEleves', 0)
    unique_eleves = data.get('uniqueEleves', 0)
    moy_glob = A.get('moyenneGlobale', 0)
    total_notes = A.get('totalNotes', 0)

    exec_text = f"""
    <b>Résumé exécutif</b><br/><br/>
    Le Groupe ISM compte <b>{fmt(total_eleves)}</b> inscriptions ({fmt(unique_eleves)} élèves uniques)
    réparties sur <b>{s.get('total',0)}</b> licences et <b>{len(data.get('schools',{}))} écoles</b>.<br/><br/>
    <b>{s.get('done',0)}</b> licences ont été extraites avec succès ({pct(s.get('done',0), s.get('total',1))}),
    <b>{s.get('skip',0)}</b> ignorées et <b>{s.get('inProgress',0)}</b> en cours.<br/><br/>
    La moyenne générale est de <b>{moy_glob}/20</b> sur {fmt(total_notes)} notes analysées.
    Les absences totales s'élèvent à <b>{fmt(round(AT.get('totalAbsences',0)))}</b>
    dont {pct(AT.get('totalJustifiees',0), AT.get('totalAbsences',1))} justifiées.
    """
    story.append(Paragraph(exec_text, styles['Body']))

    # KPI Table
    kpi_data = [
        ['Élèves', 'Classes', 'Enseignants', 'Moyenne', 'Réussite', 'Nationalités'],
        [fmt(total_eleves), fmt(data.get('totalClasses',0)), fmt(data.get('totalEnseignants',0)),
         f"{moy_glob}/20", '—', str(len(D.get('nationalites',{})))],
    ]
    # Calculer taux réussite global
    tr = A.get('tauxReussite', {})
    total_r, total_t = 0, 0
    for d in tr.values():
        total_r += d.get('reussi', 0)
        total_t += d.get('total', 0)
    kpi_data[1][4] = pct(total_r, total_t)

    t = Table(kpi_data, colWidths=[2.8*cm]*6)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTSIZE', (0,0), (-1,0), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,1), (-1,1), 11),
        ('FONTNAME', (0,1), (-1,1), 'Helvetica-Bold'),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('GRID', (0,0), (-1,-1), 0.5, GRAY),
        ('TOPPADDING', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(Spacer(1, 1*cm))
    story.append(t)

    story.append(PageBreak())

    # ═══ PAGE 2: DÉMOGRAPHIE ═══
    story.append(Paragraph('Démographie des élèves', styles['SectionTitle']))

    sex = D.get('sexe', {})
    total_p = D.get('totalPupils', 1)
    demo_text = f"""
    Sur <b>{fmt(total_p)}</b> élèves analysés :<br/>
    - Femmes : <b>{fmt(sex.get('F',0))}</b> ({pct(sex.get('F',0), total_p)})<br/>
    - Hommes : <b>{fmt(sex.get('M',0))}</b> ({pct(sex.get('M',0), total_p)})<br/>
    - Non renseigné : {fmt(sex.get('inconnu',0))}<br/><br/>
    Boursiers : <b>{fmt(D.get('boursiers',0))}</b> ({pct(D.get('boursiers',0), total_p)}) |
    Redoublants : <b>{fmt(D.get('redoublants',0))}</b> ({pct(D.get('redoublants',0), total_p)}) |
    Exempts de frais : <b>{fmt(D.get('exempts',0))}</b>
    """
    story.append(Paragraph(demo_text, styles['Body']))

    # Top 10 nationalités
    story.append(Paragraph('Top 10 nationalités', styles['SubSection']))
    nats = sorted(D.get('nationalites', {}).items(), key=lambda x: -x[1])[:10]
    nat_data = [['Nationalité', 'Effectif', '% du total']] + [
        [n, fmt(c), pct(c, total_p)] for n, c in nats
    ]
    t = Table(nat_data, colWidths=[6*cm, 3*cm, 3*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]))
    story.append(t)

    # Niveaux
    story.append(Paragraph('Répartition par niveau', styles['SubSection']))
    nivs = sorted(D.get('niveaux', {}).items(), key=lambda x: -x[1])[:8]
    niv_data = [['Niveau', 'Effectif']] + [[n, fmt(c)] for n, c in nivs]
    t = Table(niv_data, colWidths=[6*cm, 3*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]))
    story.append(t)

    story.append(PageBreak())

    # ═══ PAGE 3: ACADÉMIQUE ═══
    story.append(Paragraph('Performance académique', styles['SectionTitle']))

    cc_ex = A.get('ccVsExam', {})
    acad_text = f"""
    Moyenne générale : <b>{moy_glob}/20</b> sur {fmt(total_notes)} notes.<br/>
    Contrôle Continu : <b>{cc_ex.get('cc',{}).get('moy',0)}/20</b> ({fmt(cc_ex.get('cc',{}).get('count',0))} notes)<br/>
    Examen : <b>{cc_ex.get('exam',{}).get('moy',0)}/20</b> ({fmt(cc_ex.get('exam',{}).get('count',0))} notes)
    """
    story.append(Paragraph(acad_text, styles['Body']))

    # Moyennes par école
    story.append(Paragraph('Moyennes et taux de réussite par école', styles['SubSection']))
    moy_ecoles = A.get('moyenneParEcole', {})
    taux_ecoles = A.get('tauxReussite', {})
    ecole_data = [['École', 'Moyenne /20', 'Taux réussite', 'Notes']]
    for school in sorted(moy_ecoles.keys()):
        m = moy_ecoles[school]
        tr = taux_ecoles.get(school, {})
        ecole_data.append([
            school.replace('ISM Dakar ', ''),
            f"{m.get('moy',0)}/20",
            f"{tr.get('taux',0)}%",
            fmt(m.get('count',0))
        ])
    t = Table(ecole_data, colWidths=[5*cm, 2.5*cm, 3*cm, 3*cm])
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), BLUE),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
    ]))
    story.append(t)

    # Palmarès
    story.append(Paragraph('Matières les plus difficiles', styles['SubSection']))
    diff = P.get('plusDifficiles', [])[:10]
    if diff:
        pd_data = [['Matière', 'Moyenne', 'Réussite', 'Notes']]
        for m in diff:
            pd_data.append([m['matiere'][:40], f"{m['moy']}/20", f"{m['tauxReussite']}%", fmt(m['count'])])
        t = Table(pd_data, colWidths=[6*cm, 2*cm, 2.5*cm, 2.5*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), RED),
            ('TEXTCOLOR', (0,0), (-1,0), WHITE),
            ('FONTSIZE', (0,0), (-1,-1), 8),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ]))
        story.append(t)

    story.append(PageBreak())

    # ═══ PAGE 4: QUALITÉ + PROJECTIONS ═══
    story.append(Paragraph('Qualité des données', styles['SectionTitle']))

    comp = Q.get('completude', {})
    miss = Q.get('missing', {})
    qual_text = f"""
    Complétude des champs élèves ({fmt(Q.get('total',0))} fiches analysées) :<br/>
    - Sexe : <b>{comp.get('sexe',0)}%</b> ({fmt(miss.get('sexe',0))} manquants)<br/>
    - Nationalité : <b>{comp.get('nationalite',0)}%</b> ({fmt(miss.get('nationalite',0))} manquants)<br/>
    - Date de naissance : <b>{comp.get('dateNaissance',0)}%</b> ({fmt(miss.get('dateNaissance',0))} manquants)<br/>
    - Email : <b>{comp.get('email',0)}%</b> ({fmt(miss.get('email',0))} manquants)<br/>
    - Téléphone : <b>{comp.get('telephone',0)}%</b> ({fmt(miss.get('telephone',0))} manquants)
    """
    story.append(Paragraph(qual_text, styles['Body']))

    # Projections
    story.append(Paragraph('Projections d\'effectifs', styles['SectionTitle']))
    if PR:
        proj_data = [['École', 'Dernier', 'Croissance', 'Proj. 2027', 'Proj. 2028']]
        for school, p in sorted(PR.items()):
            proj_data.append([
                school.replace('ISM Dakar ', ''),
                fmt(p.get('lastYear',0)),
                f"{'+' if p.get('growth',0)>=0 else ''}{p.get('growth',0)}%",
                fmt(p.get('predict2027',0)),
                fmt(p.get('predict2028',0)),
            ])
        t = Table(proj_data, colWidths=[4.5*cm, 2.2*cm, 2.5*cm, 2.5*cm, 2.5*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), BLUE),
            ('TEXTCOLOR', (0,0), (-1,0), WHITE),
            ('FONTSIZE', (0,0), (-1,-1), 9),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
            ('TOPPADDING', (0,0), (-1,-1), 5),
            ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ]))
        story.append(t)
    else:
        story.append(Paragraph('Pas assez de données pour les projections.', styles['Small']))

    # Anomalies
    anom = B.get('anomalies', {}).get('highAbsenteeism', [])
    if anom:
        story.append(Paragraph(f'Classes à fort absentéisme ({len(anom)} détectées)', styles['SubSection']))
        an_data = [['École', 'Classe', 'Moy. absences']] + [
            [a['school'].replace('ISM Dakar ',''), a['classe'], str(a['avgAbsences'])]
            for a in anom[:15]
        ]
        t = Table(an_data, colWidths=[5*cm, 4*cm, 3*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), ORANGE),
            ('TEXTCOLOR', (0,0), (-1,0), WHITE),
            ('FONTSIZE', (0,0), (-1,-1), 8),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('GRID', (0,0), (-1,-1), 0.5, HexColor('#e2e8f0')),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [WHITE, LIGHT]),
            ('TOPPADDING', (0,0), (-1,-1), 4),
            ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ]))
        story.append(t)

    # Footer
    story.append(Spacer(1, 2*cm))
    story.append(HRFlowable(width="100%", color=GRAY, thickness=0.5))
    story.append(Paragraph(f'Groupe ISM — Rapport généré automatiquement le {now}', styles['Small']))

    doc.build(story)
    print(f'✅ Rapport PDF généré : {OUTPUT_FILE}')

if __name__ == '__main__':
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    build_pdf(data)

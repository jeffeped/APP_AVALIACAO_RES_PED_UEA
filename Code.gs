// ============================================================
// ResidPed UEA — Google Apps Script v2
// Sincronização com Google Sheets
// Cole este código em: script.google.com → Novo projeto
// ============================================================

// ── CONFIGURAÇÃO ────────────────────────────────────────────
const SPREADSHEET_ID = ''; // Deixe vazio → cria automaticamente na 1ª execução
const SHEET_AVALIACOES   = 'Avaliações';
const SHEET_FREQUENCIAS  = 'Frequência';
const SHEET_AUTOAVAL     = 'Autoavaliações';
const SHEET_RESIDENTES   = 'Residentes';
const SHEET_LOG          = 'Log de Sincronização';

// ── CABEÇALHOS DE CADA ABA ──────────────────────────────────
const HEADERS = {
  avaliacoes: [
    'ID', 'Data', 'Residente', 'Ano', 'Período', 'Setor',
    'Nota Conhecimentos', 'Nota Habilidades', 'Nota Atitudes',
    'Média Final', 'Conceito', 'Observações', 'Sincronizado em'
  ],
  frequencias: [
    'Data', 'Ano', 'Módulo', 'Residente', 'Período', 'Status', 'Sincronizado em'
  ],
  autoavaliacoes: [
    'ID', 'Data', 'Residente', 'Ano', 'Período',
    'Competência', 'Nota (1-4)', 'Reflexão', 'Sincronizado em'
  ],
  residentes: [
    'Ano', 'ID', 'Nome', 'Data', 'Período', 'Presença Manhã', 'Presença Tarde',
    'Total Dias', '% Frequência Manhã', '% Frequência Tarde', 'Sincronizado em'
  ]
};

// ── PONTO DE ENTRADA PRINCIPAL ──────────────────────────────
function doPost(e) {
  try {
    const raw = e.postData ? e.postData.contents : '{}';
    const payload = JSON.parse(raw);
    const tipo = payload.tipo;
    const dados = payload.dados;
    const ss = getOrCreateSpreadsheet();

    let resultado;
    switch(tipo) {
      case 'avaliacao':     resultado = salvarAvaliacao(ss, dados);    break;
      case 'frequencia':    resultado = salvarFrequencia(ss, dados);   break;
      case 'autoavaliacao': resultado = salvarAutoaval(ss, dados);     break;
      case 'residentes':    resultado = salvarResidentes(ss, dados);   break;
      case 'batch':         resultado = salvarBatch(ss, dados);        break;
      default:
        return jsonResponse({ ok: false, erro: 'Tipo desconhecido: ' + tipo });
    }

    registrarLog(ss, tipo, resultado.registros || 1, 'OK');
    return jsonResponse({ ok: true, ...resultado });

  } catch(err) {
    try {
      const ss = getOrCreateSpreadsheet();
      registrarLog(ss, 'ERRO', 0, err.message);
    } catch(_) {}
    return jsonResponse({ ok: false, erro: err.message });
  }
}

// Permite testar via GET no browser (retorna status)
function doGet(e) {
  const ss = getOrCreateSpreadsheet();
  const url = ss.getUrl();
  return jsonResponse({
    ok: true,
    status: 'ResidPed UEA — Apps Script ativo',
    planilha: url,
    versao: '2.0',
    timestamp: new Date().toISOString()
  });
}

// ── SALVAR AVALIAÇÃO ────────────────────────────────────────
function salvarAvaliacao(ss, dados) {
  const sheet = getOrCreateSheet(ss, SHEET_AVALIACOES, HEADERS.avaliacoes);
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });

  if(isDuplicata(sheet, dados.id)) {
    return { ok: true, acao: 'ignorado', motivo: 'já sincronizado' };
  }

  const nota = parseFloat(dados.media_final);
  const conceito = nota >= 9 ? 'Ótimo' : nota >= 7 ? 'Bom' : nota >= 5 ? 'Regular' : 'Insatisfatório';

  sheet.appendRow([
    dados.id,
    dados.data,
    dados.residente,
    dados.ano,
    dados.periodo,
    dados.setor || '',
    dados.dominios?.conhecimentos || '',
    dados.dominios?.habilidades || '',
    dados.dominios?.atitudes || '',
    dados.media_final,
    conceito,
    dados.obs || '',
    agora
  ]);

  formatarUltimaLinha(sheet, nota);
  return { acao: 'salvo', tipo: 'avaliacao', residente: dados.residente };
}

// ── SALVAR FREQUÊNCIA (legado) ──────────────────────────────
function salvarFrequencia(ss, dados) {
  const sheet = getOrCreateSheet(ss, SHEET_FREQUENCIAS, HEADERS.frequencias);
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });

  if(isDuplicata(sheet, dados.id)) {
    return { ok: true, acao: 'ignorado', motivo: 'já sincronizado' };
  }

  let count = 0;
  (dados.residentes || []).forEach(r => {
    sheet.appendRow([
      dados.data,
      dados.ano || '',
      dados.setor || '',
      r.nome,
      r.periodo || '',
      r.status,
      agora
    ]);
    colorirFrequencia(sheet, r.status);
    count++;
  });

  return { acao: 'salvo', tipo: 'frequencia', registros: count };
}

// ── SALVAR AUTOAVALIAÇÃO ────────────────────────────────────
function salvarAutoaval(ss, dados) {
  const sheet = getOrCreateSheet(ss, SHEET_AUTOAVAL, HEADERS.autoavaliacoes);
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });

  if(isDuplicata(sheet, dados.id)) {
    return { ok: true, acao: 'ignorado', motivo: 'já sincronizado' };
  }

  let count = 0;
  (dados.respostas || []).forEach(r => {
    if(r.nota !== null) {
      sheet.appendRow([
        dados.id,
        new Date().toLocaleDateString('pt-BR'),
        dados.nome,
        dados.ano,
        dados.periodo,
        r.competencia,
        r.nota,
        count === 0 ? (dados.reflexao || '') : '',
        agora
      ]);
      count++;
    }
  });

  return { acao: 'salvo', tipo: 'autoavaliacao', registros: count };
}

// ── SALVAR RESIDENTES + FREQUÊNCIA (novo APP residped_v3) ───
// Exporta um resumo de frequência por residente por ano
function salvarResidentes(ss, appData) {
  const sheet = getOrCreateSheet(ss, SHEET_RESIDENTES, HEADERS.residentes);
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' });

  // Limpa dados existentes (exceto cabeçalho) para substituir pelo estado atual
  const lastRow = sheet.getLastRow();
  if(lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  let count = 0;
  const anos = ['R1', 'R2', 'R3'];

  anos.forEach(ano => {
    const prog = (appData.programas || {})[ano] || {};
    const residentes = (appData.residentes || {})[ano] || {};
    const moduloNome = prog.moduloName || '';

    // Calcula dias letivos do módulo
    const diasLetivos = (prog.startDate && prog.endDate)
      ? getWeekdaysCount(prog.startDate, prog.endDate)
      : 0;

    Object.values(residentes).forEach(r => {
      const att = r.attendance || {};
      const dias = Object.keys(att);
      let mP = 0, mA = 0, mT = 0, aP = 0, aA = 0, aT = 0, total = 0;

      dias.forEach(d => {
        const reg = att[d] || {};
        // morning
        if(reg.morning === 'P') mP++;
        else if(reg.morning === 'A') mA++;
        else if(reg.morning === 'T') mT++;
        // afternoon
        if(reg.afternoon === 'P') aP++;
        else if(reg.afternoon === 'A') aA++;
        else if(reg.afternoon === 'T') aT++;
        if(reg.morning || reg.afternoon) total++;
      });

      const totalReg = mP + mA + mT;
      const totalRegT = aP + aA + aT;
      const pctM = totalReg ? Math.round((mP / totalReg) * 100) : '';
      const pctT = totalRegT ? Math.round((aP / totalRegT) * 100) : '';

      sheet.appendRow([
        ano,
        r.id,
        r.name,
        new Date().toLocaleDateString('pt-BR'),
        moduloNome,
        `P:${mP} A:${mA} T:${mT}`,
        `P:${aP} A:${aA} T:${aT}`,
        diasLetivos,
        pctM !== '' ? pctM + '%' : '–',
        pctT !== '' ? pctT + '%' : '–',
        agora
      ]);

      // Colorir % frequência
      const ultima = sheet.getLastRow();
      const pct = pctM !== '' ? pctM : (pctT !== '' ? pctT : null);
      if(pct !== null) {
        const cor = pct >= 75
          ? { bg: '#C8F0DC', fg: '#004D29' }
          : pct >= 60
            ? { bg: '#FFF3CD', fg: '#664D00' }
            : { bg: '#FFD6D6', fg: '#6B0000' };
        sheet.getRange(ultima, 9, 1, 2).setBackground(cor.bg).setFontColor(cor.fg).setFontWeight('bold');
      }

      count++;
    });

    // Linha separadora entre anos
    if(count > 0) {
      const anoHdr = [`── ${ano} ──`, '', '', '', '', '', '', '', '', '', ''];
      sheet.appendRow(anoHdr);
      const sepRow = sheet.getLastRow();
      sheet.getRange(sepRow, 1, 1, HEADERS.residentes.length)
        .setBackground('#E8EDF2')
        .setFontWeight('bold')
        .setFontColor('#4A5568');
    }
  });

  return { acao: 'salvo', tipo: 'residentes', registros: count };
}

// Conta dias úteis (seg–sex) entre duas datas ISO
function getWeekdaysCount(startISO, endISO) {
  const start = new Date(startISO + 'T12:00:00');
  const end   = new Date(endISO + 'T12:00:00');
  let count = 0, cur = new Date(start);
  while(cur <= end) {
    const d = cur.getDay();
    if(d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── SALVAR BATCH (múltiplos registros offline) ──────────────
function salvarBatch(ss, dados) {
  let total = 0;
  const erros = [];

  (dados.avaliacoes || []).forEach(a => {
    try { salvarAvaliacao(ss, a); total++; } catch(e) { erros.push(e.message); }
  });
  (dados.autoavaliacoes || []).forEach(a => {
    try { salvarAutoaval(ss, a); total++; } catch(e) { erros.push(e.message); }
  });
  // batch pode incluir o estado completo de residentes
  if(dados.residentes) {
    try { salvarResidentes(ss, dados.residentes); total++; } catch(e) { erros.push(e.message); }
  }

  return { acao: 'batch', registros: total, erros };
}

// ── UTILITÁRIOS ─────────────────────────────────────────────
function getOrCreateSpreadsheet() {
  if(SPREADSHEET_ID) {
    return SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  const files = DriveApp.getFilesByName('ResidPed UEA — Dados');
  if(files.hasNext()) {
    return SpreadsheetApp.open(files.next());
  }
  const ss = SpreadsheetApp.create('ResidPed UEA — Dados');
  ss.getActiveSheet().setName(SHEET_AVALIACOES);
  Logger.log('Planilha criada: ' + ss.getUrl());
  return ss;
}

function getOrCreateSheet(ss, nome, headers) {
  let sheet = ss.getSheetByName(nome);
  if(!sheet) {
    sheet = ss.insertSheet(nome);
    sheet.appendRow(headers);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#006B3F');
    headerRange.setFontColor('#FFFFFF');
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(11);
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  }
  return sheet;
}

function isDuplicata(sheet, id) {
  if(!id) return false;
  const data = sheet.getDataRange().getValues();
  return data.some(row => String(row[0]) === String(id));
}

function formatarUltimaLinha(sheet, nota) {
  const ultima = sheet.getLastRow();
  const range = sheet.getRange(ultima, 10, 1, 1);
  if(nota >= 9)      range.setBackground('#C8F0DC').setFontColor('#004D29');
  else if(nota >= 7) range.setBackground('#C8E6FF').setFontColor('#003D6B');
  else if(nota >= 5) range.setBackground('#FFF3CD').setFontColor('#664D00');
  else               range.setBackground('#FFD6D6').setFontColor('#6B0000');
}

function colorirFrequencia(sheet, status) {
  const ultima = sheet.getLastRow();
  const range = sheet.getRange(ultima, 6, 1, 1);
  if(status === 'P' || status === 'presente')
    range.setBackground('#C8F0DC').setFontColor('#004D29');
  else if(status === 'T' || status === 'atraso')
    range.setBackground('#FFF3CD').setFontColor('#664D00');
  else
    range.setBackground('#FFD6D6').setFontColor('#6B0000');
}

function registrarLog(ss, tipo, registros, status) {
  const sheet = getOrCreateSheet(ss, SHEET_LOG, [
    'Timestamp', 'Tipo', 'Registros', 'Status'
  ]);
  sheet.appendRow([
    new Date().toLocaleString('pt-BR', { timeZone: 'America/Manaus' }),
    tipo, registros, status
  ]);
  const total = sheet.getLastRow();
  if(total > 501) sheet.deleteRows(2, total - 501);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

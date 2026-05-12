const express  = require('express');
const multer   = require('multer');
const XLSX     = require('xlsx');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const fs       = require('fs');
const path     = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'brzn-dev-secret-cambiar-en-produccion';
const DATA_PATH  = path.join(__dirname, 'data', 'data.json');
const USERS_PATH = path.join(__dirname, 'data', 'users.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));

// ============================================================
// HELPERS DE DATOS
// ============================================================
function readData() {
  if (!fs.existsSync(DATA_PATH)) return { obras: [] };
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  // Migrar formato viejo (single obra) al nuevo (array de obras)
  if (raw.rubros && !raw.obras) {
    return { obras: [{ id: '1', nombre: raw.obra || 'Obra importada', cliente: raw.cliente || '', tc: raw.tc || 0, rubros: raw.rubros, updatedAt: raw.updatedAt, updatedBy: raw.updatedBy || '' }] };
  }
  return raw.obras ? raw : { obras: [] };
}

function writeData(data) {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function genId() { return Date.now().toString() + Math.random().toString(36).slice(2, 6); }

// ============================================================
// SETUP DE USUARIOS
// ============================================================
async function setupUsers() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const users = [];
  for (let i = 1; i <= 5; i++) {
    const name = process.env[`USER${i}_NAME`];
    const pass = process.env[`USER${i}_PASS`];
    if (name && pass) {
      users.push({ username: name, password: await bcrypt.hash(pass, 10) });
      console.log(`  ✅ Usuario: ${name}`);
    }
  }
  if (users.length > 0) {
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
    console.log(`\n👥 ${users.length} usuario(s) cargado(s)`);
  } else if (!fs.existsSync(USERS_PATH)) {
    fs.writeFileSync(USERS_PATH, JSON.stringify([{ username: 'admin', password: await bcrypt.hash('brzn2026', 10) }], null, 2));
    console.log('⚠️  Usuario por defecto: admin / brzn2026');
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sesión expirada' }); }
}

// ============================================================
// RUTAS AUTH
// ============================================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (!fs.existsSync(USERS_PATH)) return res.status(500).json({ error: 'Usuarios no configurados' });
  const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  console.log(`🔐 Login: ${user.username} — ${new Date().toLocaleString('es-AR')}`);
  res.json({ token, username: user.username });
});

// ============================================================
// RUTAS DE DATOS
// ============================================================

// Devuelve todas las obras
app.get('/api/data', auth, (req, res) => res.json(readData()));

// Upload Excel → upsert obra
const storage = multer.diskStorage({
  destination: (req, file, cb) => { const d = path.join(__dirname, 'uploads'); if (!fs.existsSync(d)) fs.mkdirSync(d); cb(null, d); },
  filename:    (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.post('/api/upload', auth, upload.single('excel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  try {
    const wb     = XLSX.readFile(req.file.path);
    const parsed = parseExcel(wb, req.user.username);
    const data   = readData();

    // Fallback: si el parser no detectó nombre, usar el nombre del archivo sin extensión
    const fileBasename = req.file.originalname.replace(/\.xlsx?$/i, '').replace(/[_-]+/g, ' ').trim();
    const obraName = (parsed.obra || '').trim() || fileBasename || 'Obra sin nombre';
    // Comparación normalizando unicode y espacios para evitar duplicados por tildes/encoding
    const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const idx = data.obras.findIndex(o => normalize(o.nombre) === normalize(obraName));

    const obraData = {
      id:        idx >= 0 ? data.obras[idx].id : genId(),
      nombre:    obraName,
      cliente:   parsed.cliente || '',
      tc:        parsed.tc || 0,
      rubros:      parsed.rubros,
      cashflow:    parsed.cashflow,
      proveedores: parsed.proveedores,
      updatedAt:   parsed.updatedAt,
      updatedBy: parsed.updatedBy
    };

    if (idx >= 0) data.obras[idx] = obraData;
    else          data.obras.push(obraData);

    writeData(data);
    fs.unlinkSync(req.file.path);
    console.log(`📊 Excel subido por ${req.user.username} — obra: "${obraName}" (${parsed.rubros.length} rubros)`);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('❌ Error Excel:', err.message);
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Error al procesar el Excel: ' + err.message });
  }
});

// Editar obra (nombre, cliente, tc)
app.put('/api/obras/:id', auth, (req, res) => {
  const data = readData();
  const idx  = data.obras.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Obra no encontrada' });
  const { nombre, cliente, tc } = req.body;
  if (nombre  !== undefined) data.obras[idx].nombre  = nombre;
  if (cliente !== undefined) data.obras[idx].cliente = cliente;
  if (tc      !== undefined) data.obras[idx].tc      = tc;
  writeData(data);
  console.log(`✏️  Obra editada: "${data.obras[idx].nombre}" por ${req.user.username}`);
  res.json({ ok: true, obra: data.obras[idx] });
});

// Eliminar obra
app.delete('/api/obras/:id', auth, (req, res) => {
  const data = readData();
  const obra = data.obras.find(o => o.id === req.params.id);
  if (!obra) return res.status(404).json({ error: 'Obra no encontrada' });
  data.obras = data.obras.filter(o => o.id !== req.params.id);
  writeData(data);
  console.log(`🗑️  Obra eliminada: "${obra.nombre}" por ${req.user.username}`);
  res.json({ ok: true });
});

// Agregar movimiento manual de cashflow
app.post('/api/obras/:id/cashflow', auth, (req, res) => {
  const data = readData();
  const idx  = data.obras.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Obra no encontrada' });

  const { fecha, tipo, rubro, desc, proveedor, monto, estado } = req.body;
  if (!fecha || !tipo || !monto) return res.status(400).json({ error: 'Faltan datos obligatorios' });
  if (!['Ingreso','Gasto'].includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

  const mov = {
    id:        genId(),
    fecha,
    obra:      data.obras[idx].nombre,
    tipo,
    rubro:     rubro     || '',
    desc:      desc      || '',
    proveedor: proveedor || '',
    monto:     parseFloat(monto),
    estado:    estado    || 'Pendiente',
    manual:    true
  };

  if (!data.obras[idx].cashflow) data.obras[idx].cashflow = [];
  data.obras[idx].cashflow.push(mov);
  data.obras[idx].updatedAt = new Date().toISOString();
  data.obras[idx].updatedBy = req.user.username;

  writeData(data);
  console.log(`💰 Movimiento manual por ${req.user.username}: ${tipo} $${monto} — "${data.obras[idx].nombre}"`);
  res.json({ ok: true, mov, data });
});

// Editar movimiento de cashflow por índice en el array
app.put('/api/obras/:id/cashflow/:idx', auth, (req, res) => {
  const data    = readData();
  const obraIdx = data.obras.findIndex(o => o.id === req.params.id);
  if (obraIdx < 0) return res.status(404).json({ error: 'Obra no encontrada' });

  const cf     = data.obras[obraIdx].cashflow || [];
  const movIdx = parseInt(req.params.idx, 10);
  if (isNaN(movIdx) || movIdx < 0 || movIdx >= cf.length) return res.status(404).json({ error: 'Movimiento no encontrado' });

  const { fecha, tipo, rubro, desc, proveedor, monto, estado } = req.body;
  if (!fecha || !tipo || !monto) return res.status(400).json({ error: 'Faltan datos obligatorios' });

  Object.assign(cf[movIdx], { fecha, tipo, rubro: rubro || '', desc: desc || '', proveedor: proveedor || '', monto: parseFloat(monto), estado: estado || 'Pendiente' });
  data.obras[obraIdx].updatedAt = new Date().toISOString();
  data.obras[obraIdx].updatedBy = req.user.username;

  writeData(data);
  console.log(`✏️  Movimiento cashflow editado por ${req.user.username} — obra "${data.obras[obraIdx].nombre}" idx ${movIdx}`);
  res.json({ ok: true, data });
});

// Eliminar movimiento manual de cashflow
app.delete('/api/obras/:id/cashflow/:idx', auth, (req, res) => {
  const data    = readData();
  const obraIdx = data.obras.findIndex(o => o.id === req.params.id);
  if (obraIdx < 0) return res.status(404).json({ error: 'Obra no encontrada' });

  const cf     = data.obras[obraIdx].cashflow || [];
  const movIdx = parseInt(req.params.idx, 10);
  if (isNaN(movIdx) || movIdx < 0 || movIdx >= cf.length) return res.status(404).json({ error: 'Movimiento no encontrado' });

  cf.splice(movIdx, 1);
  data.obras[obraIdx].cashflow = cf;
  writeData(data);
  res.json({ ok: true, data });
});

// Asociar/fusionar dos obras (los rubros de deleteId se unen a keepId)
app.post('/api/obras/merge', auth, (req, res) => {
  const { keepId, deleteId } = req.body;
  if (!keepId || !deleteId || keepId === deleteId) return res.status(400).json({ error: 'IDs inválidos' });
  const data    = readData();
  const keepIdx = data.obras.findIndex(o => o.id === keepId);
  const delIdx  = data.obras.findIndex(o => o.id === deleteId);
  if (keepIdx < 0 || delIdx < 0) return res.status(404).json({ error: 'Obra no encontrada' });

  // Fusionar rubros: si el código ya existe en keepId, se queda con el mayor presupuestado
  const keepRubros = [...data.obras[keepIdx].rubros];
  data.obras[delIdx].rubros.forEach(r => {
    const existing = keepRubros.findIndex(k => k.cod === r.cod);
    if (existing < 0) keepRubros.push(r);
    else if (r.presupuestado > keepRubros[existing].presupuestado) keepRubros[existing] = r;
  });

  data.obras[keepIdx].rubros    = keepRubros;
  data.obras[keepIdx].updatedAt = new Date().toISOString();
  data.obras[keepIdx].updatedBy = req.user.username;
  data.obras = data.obras.filter(o => o.id !== deleteId);

  writeData(data);
  console.log(`🔗 Obras fusionadas por ${req.user.username}`);
  res.json({ ok: true, data });
});

// ============================================================
// PARSER EXCEL
// ============================================================

// Parsea un valor numérico tolerando tanto formato anglosajón (7412492.354)
// como formato argentino (1.234.567,89) sin romper los decimales.
function parseNum(val) {
  if (val === null || val === undefined) return 0;
  const s = String(val).trim();
  if (!s || s === 'Bonificado' || s.startsWith('#')) return 0;
  // Si ya es un número JS válido (SheetJS lo suele entregar así)
  const direct = parseFloat(s);
  if (!isNaN(direct) && !s.includes(',')) return Math.round(direct * 100) / 100;
  // Formato argentino: "1.234.567,89" → quitar puntos, coma → punto
  const cleaned = s.replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const result  = parseFloat(cleaned);
  return isNaN(result) ? 0 : Math.round(result * 100) / 100;
}

// Normaliza una fecha de Excel a string "YYYY-MM-DD"
function parseFecha(val) {
  if (!val) return '';
  // SheetJS puede entregar un Date, un número serial, o un string
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  // "2025-01-01 00:00:00" o "2025-01-01T00:00:00"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // Número serial de Excel (días desde 1/1/1900)
  const n = parseFloat(s);
  if (!isNaN(n) && n > 1000) {
    const d = new Date((n - 25569) * 86400 * 1000);
    return d.toISOString().slice(0, 10);
  }
  return s;
}

function parseExcel(wb, uploadedBy) {
  console.log('\n📋 Hojas:', wb.SheetNames);
  const result = { obra: '', cliente: '', tc: 0, rubros: [], cashflow: [], proveedores: [], updatedAt: new Date().toISOString(), updatedBy: uploadedBy || '' };

  // ── 1. PRESUPUESTO ──────────────────────────────────────────
  const PRES_SHEETS = ['Presupuesto', 'presupuesto', 'PRESUPUESTO'];
  const presSheetName = PRES_SHEETS.find(n => wb.SheetNames.includes(n)) || wb.SheetNames[0];

  for (const sheetName of [presSheetName, ...wb.SheetNames.filter(n => n !== presSheetName)]) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    console.log(`\n--- "${sheetName}" (${rows.length} filas) ---`);
    rows.slice(0, 45).forEach((r, i) => { if (r.some(c => c !== '')) console.log(`  [${i}]`, r.slice(0,10).map(c => String(c).substring(0,28))); });

    let currentRubro = null;

    for (const row of rows) {
      // Buscar código en col A (idx 0) o col B (idx 1) — soporte para ambos formatos
      const col0 = String(row[0] || '').trim();
      const col1 = String(row[1] || '').trim();
      const col2 = String(row[2] || '').trim();

      // Columna de metadatos: preferir col B, fallback col A
      const meta    = col1 || col0;
      const metaLow = meta.toLowerCase();

      // ── Metadatos: "Cliente: ...", "Dirección: ...", "TC: ..."
      // Normalizar para comparar sin importar tildes ni mayúsculas
      const metaNorm = meta.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (!result.cliente && metaNorm.includes('cliente:')) {
        result.cliente = meta.slice(meta.indexOf(':') + 1).trim();
      }
      if (!result.obra && (metaNorm.includes('direcci') || metaNorm.includes('obra:'))) {
        result.obra = meta.slice(meta.indexOf(':') + 1).trim();
      }
      // Fallback: usar "Referencia:" si no hay dirección/obra
      if (!result.obra && metaNorm.includes('referencia:')) {
        result.obra = meta.slice(meta.indexOf(':') + 1).trim();
      }
      if (!result.tc && metaLow.includes('tc:')) {
        const tcF = parseFloat(String(row[5] || ''));
        if (!isNaN(tcF) && tcF > 100) { result.tc = tcF; }
        else { const m = meta.match(/[\d.,]+/); if (m) result.tc = parseNum(m[0]); }
      }

      // ── Código de rubro: buscar en col A o col B (col B tiene espacios a veces)
      const codA = col0.replace(/^\s+/, '');
      const codB = col1.replace(/^\s+/, '');
      const cod  = /^\d{1,2}-\d{2}$/.test(codA) ? codA : /^\d{1,2}-\d{2}$/.test(codB) ? codB : '';
      // Descripción está en la columna siguiente al código
      const desc = cod === codA ? (col1 || col2) : col2;
      // Total (VALOR TOTAL): si código en col A → idx 7; si en col B → idx 8
      const totalIdx = cod === codA ? 7 : 8;
      const pres = parseNum(row[totalIdx]);

      if (!cod) continue;

      if (/^\d{1,2}-00$/.test(cod)) {
        currentRubro = { cod, desc: desc.trim(), presupuestado: pres, ejecutado: 0, items: [] };
        result.rubros.push(currentRubro);
      } else if (currentRubro) {
        currentRubro.items.push({ cod, desc: desc.trim(), presupuestado: pres, ejecutado: 0 });
      }
    }

    if (result.rubros.length > 0) {
      console.log(`✅ ${result.rubros.length} rubros en "${sheetName}" (${result.rubros.reduce((s,r)=>s+r.items.length,0)} sub-ítems)`);
      break;
    }
  }

  // ── 2. CASHFLOW ─────────────────────────────────────────────
  const CF_SHEETS = ['Cashflow', 'cashflow', 'CASHFLOW', 'Cash Flow'];
  const cfSheetName = CF_SHEETS.find(n => wb.SheetNames.includes(n));

  if (cfSheetName) {
    const cfRows = XLSX.utils.sheet_to_json(wb.Sheets[cfSheetName], { header: 1, defval: '' });
    // Buscar fila de encabezado (contiene "Fecha" o "fecha")
    let headerIdx = cfRows.findIndex(r => String(r[0] || r[1] || '').toLowerCase().includes('fecha'));
    if (headerIdx < 0) headerIdx = 5; // fallback posición conocida

    for (let i = headerIdx + 1; i < cfRows.length; i++) {
      const r     = cfRows[i];
      const fecha = parseFecha(r[0]);
      const tipo  = String(r[2] || '').trim();
      const monto = parseNum(r[6]);
      if (!fecha || !tipo || !monto) continue;

      result.cashflow.push({
        fecha,
        obra:      String(r[1] || '').trim(),
        tipo:      tipo === 'Egreso' ? 'Gasto' : tipo,  // normalizar Egreso → Gasto
        rubro:     String(r[3] || '').trim(),
        desc:      String(r[4] || '').trim(),
        proveedor: String(r[5] || '').trim(),
        monto,
        estado:    String(r[7] || 'Pendiente').trim()
      });
    }
    console.log(`✅ ${result.cashflow.length} movimientos cashflow en "${cfSheetName}"`);
  }

  // ── 3. PROVEEDORES ──────────────────────────────────────────
  const PROV_SHEETS = ['Proveedores', 'proveedores', 'PROVEEDORES'];
  const provSheetName = PROV_SHEETS.find(n => wb.SheetNames.includes(n));

  if (provSheetName) {
    const provRows = XLSX.utils.sheet_to_json(wb.Sheets[provSheetName], { header: 1, defval: '' });
    // Buscar fila de encabezado (contiene "Proveedor")
    let provHeaderIdx = provRows.findIndex(r =>
      r.some(c => String(c).toLowerCase().includes('proveedor'))
    );
    if (provHeaderIdx < 0) provHeaderIdx = 4; // fallback: fila 5 (idx 4)

    for (let i = provHeaderIdx + 1; i < provRows.length; i++) {
      const r      = provRows[i];
      const nombre = String(r[0] || '').trim();
      if (!nombre) continue;  // saltar filas vacías
      const gastoEjecutado = parseNum(r[1]);
      const pct            = parseNum(r[2]);  // puede ser 0.25 (25%) o 25
      result.proveedores.push({ nombre, gastoEjecutado, pct });
    }
    console.log(`✅ ${result.proveedores.length} proveedores en "${provSheetName}"`);
  }

  console.log('📦 Parse:', { obra: result.obra, cliente: result.cliente, tc: result.tc, rubros: result.rubros.length, cashflow: result.cashflow.length, proveedores: result.proveedores.length });
  return result;
}

// ============================================================
// START
// ============================================================
setupUsers().then(() => {
  app.listen(PORT, () => console.log(`\n🚀 Dashboard brzn en puerto ${PORT}\n`));
}).catch(err => { console.error(err); process.exit(1); });

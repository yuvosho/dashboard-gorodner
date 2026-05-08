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

    const obraName = (parsed.obra || '').trim() || 'Obra sin nombre';
    const idx = data.obras.findIndex(o => o.nombre.toLowerCase().trim() === obraName.toLowerCase());

    const obraData = {
      id:        idx >= 0 ? data.obras[idx].id : genId(),
      nombre:    obraName,
      cliente:   parsed.cliente || '',
      tc:        parsed.tc || 0,
      rubros:    parsed.rubros,
      updatedAt: parsed.updatedAt,
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

function parseExcel(wb, uploadedBy) {
  console.log('\n📋 Hojas:', wb.SheetNames);
  const result = { obra: '', cliente: '', tc: 0, rubros: [], updatedAt: new Date().toISOString(), updatedBy: uploadedBy || '' };

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    console.log(`\n--- "${sheetName}" (${rows.length} filas) ---`);
    rows.slice(0, 45).forEach((r, i) => { if (r.some(c => c !== '')) console.log(`  [${i}]`, r.slice(0,10).map(c => String(c).substring(0,28))); });

    let currentRubro = null;

    for (const row of rows) {
      // En este Excel: col A (idx 0) vacía, col B (idx 1) = código/etiqueta, col C (idx 2) = descripción
      const b    = String(row[1] || '').trim();
      const bLow = b.toLowerCase();
      const c    = String(row[2] || '').trim();

      // ── Metadatos embebidos en celda B: "Cliente: ...", "Dirección: ...", "TC: ..."
      if (!result.cliente && bLow.startsWith('cliente:')) {
        result.cliente = b.slice(b.indexOf(':') + 1).trim();
      }
      if (!result.obra && (bLow.startsWith('dirección:') || bLow.startsWith('direccion:') || bLow.startsWith('obra:'))) {
        result.obra = b.slice(b.indexOf(':') + 1).trim();
      }
      if (!result.tc && bLow.startsWith('tc:')) {
        // Preferir el valor numérico de col F (idx 5) si existe
        const tcF = parseFloat(String(row[5] || ''));
        if (!isNaN(tcF) && tcF > 100) result.tc = tcF;
        else {
          const m = b.match(/[\d.,]+/);
          if (m) result.tc = parseNum(m[0]);
        }
      }

      // ── Códigos de rubro: col B puede tener espacios al inicio (" 2-12")
      const cod = b.replace(/^\s+/, '');

      if (/^\d{1,2}-00$/.test(cod)) {
        // Rubro principal (x-00): el total está en col I (idx 8)
        const pres = parseNum(row[8]);
        currentRubro = { cod, desc: c || b, presupuestado: pres, ejecutado: 0, items: [] };
        result.rubros.push(currentRubro);

      } else if (/^\d{1,2}-\d{2}$/.test(cod) && currentRubro) {
        // Sub-ítem (x-01, x-02…): guardar bajo el rubro padre
        const pres = parseNum(row[8]);
        currentRubro.items.push({ cod, desc: c, presupuestado: pres, ejecutado: 0 });
      }
    }

    if (result.rubros.length > 0) { console.log(`✅ ${result.rubros.length} rubros en "${sheetName}" (${result.rubros.reduce((s,r)=>s+r.items.length,0)} sub-ítems)`); break; }
  }

  console.log('📦 Parse:', { obra: result.obra, cliente: result.cliente, tc: result.tc, rubros: result.rubros.length });
  return result;
}

// ============================================================
// START
// ============================================================
setupUsers().then(() => {
  app.listen(PORT, () => console.log(`\n🚀 Dashboard brzn en puerto ${PORT}\n`));
}).catch(err => { console.error(err); process.exit(1); });

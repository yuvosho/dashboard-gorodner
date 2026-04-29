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

// Servir archivos estáticos desde /public
app.use(express.static(path.join(__dirname, 'public')));

// Logo en raíz (compatibilidad)
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));

// ============================================================
// SETUP DE USUARIOS DESDE VARIABLES DE ENTORNO
// Se leen USER1_NAME / USER1_PASS, USER2_NAME / USER2_PASS, etc.
// ============================================================
async function setupUsers() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const users = [];
  for (let i = 1; i <= 5; i++) {
    const name = process.env[`USER${i}_NAME`];
    const pass = process.env[`USER${i}_PASS`];
    if (name && pass) {
      const hash = await bcrypt.hash(pass, 10);
      users.push({ username: name, password: hash });
      console.log(`  ✅ Usuario configurado: ${name}`);
    }
  }

  if (users.length > 0) {
    fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
    console.log(`\n👥 ${users.length} usuario(s) cargado(s) desde variables de entorno`);
  } else {
    // Sin env vars → usuario por defecto solo para desarrollo local
    if (!fs.existsSync(USERS_PATH)) {
      const hash = await bcrypt.hash('brzn2026', 10);
      fs.writeFileSync(USERS_PATH, JSON.stringify([
        { username: 'admin', password: hash }
      ], null, 2));
      console.log('⚠️  No se encontraron variables USER1_NAME/USER1_PASS');
      console.log('⚠️  Usuario por defecto creado: admin / brzn2026');
    } else {
      console.log('👥 Usando usuarios existentes en data/users.json');
    }
  }
}

// ============================================================
// MIDDLEWARE DE AUTENTICACIÓN
// ============================================================
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada, volvé a ingresar' });
  }
}

// ============================================================
// RUTAS DE LA API
// ============================================================

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });

  if (!fs.existsSync(USERS_PATH)) {
    return res.status(500).json({ error: 'Usuarios no configurados en el servidor' });
  }

  const users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  const user  = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  console.log(`🔐 Login: ${user.username} — ${new Date().toLocaleString('es-AR')}`);
  res.json({ token, username: user.username });
});

// GET /api/data  →  devuelve los datos guardados del último Excel
app.get('/api/data', auth, (req, res) => {
  if (!fs.existsSync(DATA_PATH)) return res.json(null);
  res.json(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
});

// POST /api/upload  →  recibe el Excel, lo parsea y guarda
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20 MB máx

app.post('/api/upload', auth, upload.single('excel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  try {
    const wb   = XLSX.readFile(req.file.path);
    const data = parseExcel(wb, req.user.username);

    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    fs.unlinkSync(req.file.path);

    console.log(`📊 Excel subido por ${req.user.username} — ${data.rubros.length} rubros encontrados`);
    res.json({ ok: true, data });
  } catch (err) {
    console.error('❌ Error al procesar Excel:', err.message);
    try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: 'Error al procesar el Excel: ' + err.message });
  }
});

// ============================================================
// PARSER DE EXCEL
// Busca rubros por código (1-00, 2-00 … 15-00) en cualquier hoja.
// Imprime la estructura completa en los logs de Railway para debug.
// ============================================================
function parseExcel(wb, uploadedBy) {
  console.log('\n📋 Hojas encontradas:', wb.SheetNames);

  const RUBRO_CODES = [
    '1-00','2-00','3-00','4-00','5-00','6-00','7-00',
    '8-00','9-00','10-00','11-00','12-00','13-00','14-00','15-00'
  ];

  const result = {
    obra:      '',
    cliente:   '',
    tc:        0,
    rubros:    [],
    updatedAt: new Date().toISOString(),
    updatedBy: uploadedBy || ''
  };

  // Recorrer todas las hojas hasta encontrar rubros
  for (const sheetName of wb.SheetNames) {
    const ws   = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

    console.log(`\n--- Hoja: "${sheetName}" (${rows.length} filas) ---`);
    rows.slice(0, 40).forEach((r, i) => {
      if (r.some(c => c !== '')) console.log(`  [${i}]`, r.slice(0, 10).map(c => String(c).substring(0, 25)));
    });

    // Buscar datos de obra y cliente
    for (const row of rows) {
      const rowFlat = row.map(c => String(c).toLowerCase());
      const joined  = rowFlat.join('|');

      if (!result.obra && joined.includes('obra')) {
        const val = row.find((c, i) => i > 0 && String(c).trim().length > 3 && typeof c === 'string');
        if (val) result.obra = String(val).trim();
      }
      if (!result.cliente && joined.includes('cliente')) {
        const val = row.find((c, i) => i > 0 && String(c).trim().length > 3 && typeof c === 'string');
        if (val) result.cliente = String(val).trim();
      }
      if (!result.tc && joined.includes('tc')) {
        const val = row.find((c, i) => i > 0 && !isNaN(parseFloat(c)) && parseFloat(c) > 100);
        if (val) result.tc = parseFloat(val);
      }

      // Buscar rubros por código
      const firstCell = String(row[0] || '').trim();
      if (RUBRO_CODES.includes(firstCell)) {
        // Extraer todos los números de la fila
        const nums = row
          .map(c => parseFloat(String(c).replace(/[$ .']/g, '').replace(',', '.')))
          .filter(n => !isNaN(n) && n > 0);

        // La descripción: primer string largo que no sea el código
        const desc = row.find((c, i) => i > 0 && typeof c === 'string' && c.trim().length > 3) || '';

        result.rubros.push({
          cod:           firstCell,
          desc:          String(desc).trim(),
          presupuestado: nums[0] || 0,
          ejecutado:     nums[1] || 0
        });
      }
    }

    if (result.rubros.length > 0) {
      console.log(`\n✅ ${result.rubros.length} rubros encontrados en hoja "${sheetName}"`);
      break; // Con una hoja alcanza
    }
  }

  console.log('\n📦 Resultado del parse:', {
    obra: result.obra, cliente: result.cliente, rubros: result.rubros.length
  });

  return result;
}

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
setupUsers().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🚀 Dashboard brzn arquitectura corriendo en puerto ${PORT}`);
    console.log(`   http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});

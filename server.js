'use strict';

const {
  Client,
  MessageMedia,
  RemoteAuth
} = require('whatsapp-web.js');

const QRCode = require('qrcode');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { timingSafeEqual } = require('crypto');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

// Variáveis obrigatórias.
const requiredEnv = [
  'MONGODB_URI',
  'QR_TOKEN',
  'WHATSAPP_API_TOKEN'
];

const missingEnv = requiredEnv.filter(
  (name) => !process.env[name]
);

if (missingEnv.length > 0) {
  console.error(
    '[Configuração] Variáveis ausentes:',
    missingEnv.join(', ')
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const REMOTE_CLIENT_ID = 'versatili-whatsapp';
const REMOTE_SESSION_NAME = `RemoteAuth-${REMOTE_CLIENT_ID}`;

const chromePath = puppeteer.executablePath();

console.log('[Inicialização] Chrome:', chromePath);
console.log(
  '[Inicialização] Chrome existe:',
  fs.existsSync(chromePath)
);

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome não encontrado: ${chromePath}`);
}

let qrAtual = null;
let whatsappConectado = false;
let client = null;
let encerrando = false;
let startupWatchdog = null;

const memoryMonitor = setInterval(() => {
  const memory = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 1024 / 1024);

  console.log(
    `[Memória Node.js] RSS=${mb(memory.rss)}MB ` +
    `Heap=${mb(memory.heapUsed)}MB ` +
    `Externo=${mb(memory.external)}MB`
  );
}, 30000);

if (typeof memoryMonitor.unref === 'function') {
  memoryMonitor.unref();
}

function tokenCorreto(recebido, esperado) {
  if (
    typeof recebido !== 'string' ||
    typeof esperado !== 'string'
  ) {
    return false;
  }

  const a = Buffer.from(recebido, 'utf8');
  const b = Buffer.from(esperado, 'utf8');

  if (a.length === 0 || a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

function envioAutorizado(req) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return false;
  }

  return tokenCorreto(
    match[1],
    process.env.WHATSAPP_API_TOKEN
  );
}

function limparWatchdog() {
  if (startupWatchdog) {
    clearTimeout(startupWatchdog);
    startupWatchdog = null;
  }
}

// Página inicial.
app.get('/', (req, res) => {
  res.status(200).send('Servidor WhatsApp ativo.');
});

// QR Code protegido.
app.get('/qr', async (req, res) => {
  if (!tokenCorreto(req.query.token, process.env.QR_TOKEN)) {
    return res.status(401).send('Acesso não autorizado.');
  }

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private'
  );
  res.setHeader('Pragma', 'no-cache');

  if (whatsappConectado) {
    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>WhatsApp conectado</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h2>WhatsApp conectado!</h2>
        <p>O dispositivo está autenticado e pronto para uso.</p>
      </body>
      </html>
    `);
  }

  if (!qrAtual) {
    return res.status(503).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="5">
        <title>Aguardando QR Code</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h2>Aguardando QR Code...</h2>
        <p>A página será atualizada automaticamente.</p>
      </body>
      </html>
    `);
  }

  try {
    const image = await QRCode.toDataURL(qrAtual, {
      width: 300,
      margin: 2
    });

    return res.status(200).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="20">
        <title>Conectar WhatsApp</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:20px">
        <h2>Conectar WhatsApp</h2>
        <p>Abra o WhatsApp no celular e escaneie este código.</p>
        <img src="${image}" alt="QR Code do WhatsApp"
             style="width:100%;max-width:300px;height:auto">
        <p>Se o código expirar, aguarde a atualização da página.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(
      '[QR] Erro ao gerar imagem:',
      error.message || error
    );

    return res.status(500).send(
      'Erro ao gerar a imagem do QR Code.'
    );
  }
});

// Estado do servidor.
app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const memory = process.memoryUsage();

  return res.json({
    servidor: 'online',
    whatsapp: whatsappConectado ? 'conectado' : 'aguardando conexão',
    qrDisponivel: Boolean(qrAtual),
    mongodb: mongoose.connection.readyState === 1
      ? 'conectado'
      : 'desconectado',
    memoriaRSS_MB: Math.round(memory.rss / 1024 / 1024)
  });
});

// Lista grupos do WhatsApp, protegida pelo token.
app.get('/grupos', async (req, res) => {
  if (!envioAutorizado(req)) {
    return res.status(401).json({
      status: 'erro',
      mensagem: 'Acesso não autorizado.'
    });
  }

  if (!whatsappConectado || !client) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'WhatsApp ainda não está conectado.'
    });
  }

  try {
    const grupos = await client.pupPage.evaluate(() => {
      const chats = window
        .require('WAWebCollections')
        .Chat
        .getModelsArray();

      return chats
        .filter((chat) => chat.groupMetadata)
        .map((chat) => ({
          nome: chat.formattedTitle || chat.name || '(sem nome)',
          id: chat.id?._serialized || ''
        }))
        .filter((grupo) => grupo.id);
    });

    res.setHeader('Cache-Control', 'no-store');

    return res.json({
      status: 'ok',
      total: grupos.length,
      grupos
    });
  } catch (error) {
    console.error(
      '[Grupos] Erro ao consultar grupos:',
      error?.stack || error
    );

    return res.status(500).json({
      status: 'erro',
      mensagem: 'Não foi possível consultar os grupos.'
    });
  }
});

// Envia texto ou imagem com legenda.
app.post('/enviar', async (req, res) => {
  if (!envioAutorizado(req)) {
    return res.status(401).json({
      status: 'erro',
      mensagem: 'Acesso não autorizado.'
    });
  }

  const { grupo, foto, legenda } = req.body || {};

  if (
    typeof grupo !== 'string' ||
    !grupo.trim() ||
    grupo.length > 256
  ) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe um identificador de grupo válido.'
    });
  }

  // A imagem é opcional. Se informada, precisa ser uma string válida.
  if (
    foto !== undefined &&
    foto !== null &&
    (typeof foto !== 'string' || foto.length > 2048)
  ) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A URL da imagem deve ter até 2048 caracteres.'
    });
  }

  let fotoUrl = null;

  if (typeof foto === 'string' && foto.trim()) {
    try {
      fotoUrl = new URL(foto.trim());
    } catch {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'URL da imagem inválida.'
      });
    }

    if (
      fotoUrl.protocol !== 'https:' ||
      fotoUrl.username ||
      fotoUrl.password
    ) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'A imagem precisa usar uma URL HTTPS válida.'
      });
    }
  }

  if (
    typeof legenda !== 'string' ||
    !legenda.trim() ||
    legenda.length > 4096
  ) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A mensagem deve ter conteúdo e até 4096 caracteres.'
    });
  }

  if (!whatsappConectado || !client) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'WhatsApp ainda não está conectado.'
    });
  }

  const tipoEnvio = fotoUrl ? 'imagem' : 'texto';

  try {
    if (fotoUrl) {
      const media = await MessageMedia.fromUrl(
        fotoUrl.toString()
      );

      console.info('[Envio] Mídia preparada:', {
        tipo: media.mimetype,
        tamanhoBytes: media.data
          ? Buffer.from(media.data, 'base64').length
          : null,
        arquivo: media.filename || null
      });

      await client.sendMessage(
        grupo.trim(),
        media,
        { caption: legenda.trim() }
      );
    } else {
      await client.sendMessage(
        grupo.trim(),
        legenda.trim()
      );
    }

    console.info('[Envio] Mensagem enviada:', {
      tipoEnvio,
      grupo: grupo.trim()
    });

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo.'
    });
  } catch (error) {
    console.error('[Envio] Falha detalhada:', {
      tipoEnvio,
      name: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });

    return res.status(500).json({
      status: 'erro',
      mensagem: 'Falha ao enviar mensagem.'
    });
  }
});

// Inicia o servidor HTTP.
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Servidor] Rodando na porta ${PORT}`);
});

// Conecta ao MongoDB e inicia o WhatsApp.
async function iniciarWhatsApp() {
  console.log('[MongoDB] Conectando...');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000
  });

  console.log('[MongoDB] Conectado.');

  const store = new MongoStore({ mongoose });

  console.log(
    '[RemoteAuth] Verificando sessão:',
    REMOTE_SESSION_NAME
  );

  const sessionExists = await store.sessionExists({
    session: REMOTE_SESSION_NAME
  });

  console.log(
    '[RemoteAuth] Sessão remota encontrada:',
    sessionExists
  );

  console.log('[WhatsApp] Criando cliente...');

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: REMOTE_CLIENT_ID,
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--no-first-run',
        '--no-zygote',
        '--renderer-process-limit=1',
        '--disable-features=Translate,BackForwardCache'
      ]
    }
  });

  client.on('loading_screen', (percent, message) => {
    console.log(
      `[WhatsApp] Carregamento: ${percent}% - ${message}`
    );
  });

  client.on('change_state', (state) => {
    console.log('[WhatsApp] Estado:', state);
  });

  client.on('qr', (qr) => {
    limparWatchdog();
    qrAtual = qr;
    whatsappConectado = false;

    console.log('[WhatsApp] Novo QR Code disponível em /qr.');
  });

  client.on('authenticated', () => {
    qrAtual = null;
    console.log('[WhatsApp] Autenticado com sucesso.');
  });

  client.on('ready', () => {
    limparWatchdog();
    qrAtual = null;
    whatsappConectado = true;

    console.log('[WhatsApp] Conectado e pronto para uso.');
  });

  client.on('remote_session_saved', () => {
    console.log('[RemoteAuth] Sessão salva no MongoDB.');
  });

  client.on('auth_failure', (message) => {
    whatsappConectado = false;
    qrAtual = null;

    console.error(
      '[WhatsApp] Falha na autenticação:',
      message
    );
  });

  client.on('disconnected', (reason) => {
    whatsappConectado = false;
    qrAtual = null;

    console.warn('[WhatsApp] Desconectado:', reason);
  });

  client.on('error', (error) => {
    console.error(
      '[WhatsApp] Erro do cliente:',
      error.message || error
    );
  });

  startupWatchdog = setTimeout(() => {
    console.warn(
      '[WhatsApp] Continua aguardando QR Code ou evento ready.'
    );
  }, 60000);

  if (typeof startupWatchdog.unref === 'function') {
    startupWatchdog.unref();
  }

  console.log('[WhatsApp] Chamando client.initialize()...');

  await client.initialize();

  console.log('[WhatsApp] client.initialize() terminou.');
}

iniciarWhatsApp().catch((error) => {
  console.error(
    '[Inicialização] Falha ao iniciar WhatsApp/MongoDB:',
    error.stack || error.message || error
  );
});

// Encerramento controlado.
async function encerrarServidor() {
  if (encerrando) return;

  encerrando = true;
  limparWatchdog();
  clearInterval(memoryMonitor);

  console.log('[Servidor] Encerrando...');

  try {
    if (client) {
      await client.destroy();
    }
  } catch (error) {
    console.error(
      '[Servidor] Erro ao encerrar WhatsApp:',
      error.message || error
    );
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (error) {
    console.error(
      '[Servidor] Erro ao desconectar MongoDB:',
      error.message || error
    );
  }

  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', encerrarServidor);
process.on('SIGINT', encerrarServidor);

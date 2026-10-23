'use strict';

const {
  Client,
  MessageMedia,
  RemoteAuth
} = require('whatsapp-web.js');

const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { timingSafeEqual } = require('crypto');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

// Variáveis obrigatórias configuradas em Render > Environment.
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
    'Variáveis obrigatórias ausentes:',
    missingEnv.join(', ')
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Configuração da sessão persistente.
const REMOTE_CLIENT_ID = 'versatili-whatsapp';
const REMOTE_SESSION_NAME = `RemoteAuth-${REMOTE_CLIENT_ID}`;

const chromePath = puppeteer.executablePath();

console.log('[Inicialização] Caminho do Chrome:', chromePath);
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

// Compara tokens de forma segura.
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

// Protege o endpoint de envio por Bearer Token.
function envioAutorizado(req) {
  const cabecalho = req.get('authorization') || '';
  const resultado = cabecalho.match(/^Bearer\s+(.+)$/i);

  if (!resultado) {
    return false;
  }

  return tokenCorreto(
    resultado[1],
    process.env.WHATSAPP_API_TOKEN
  );
}

function limparAvisoInicializacao() {
  if (startupWatchdog) {
    clearTimeout(startupWatchdog);
    startupWatchdog = null;
  }
}

// Página inicial.
app.get('/', (req, res) => {
  res.status(200).send('Servidor WhatsApp ativo.');
});

// Página protegida do QR Code.
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
        <p>Se continuar assim, confira os Logs do Render.</p>
      </body>
      </html>
    `);
  }

  try {
    const imagem = await QRCode.toDataURL(qrAtual, {
      width: 350,
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
        <img src="${imagem}" alt="QR Code do WhatsApp"
             style="width:100%;max-width:350px;height:auto">
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

// Estado do servidor, WhatsApp e banco.
app.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  res.json({
    servidor: 'online',
    whatsapp: whatsappConectado
      ? 'conectado'
      : 'aguardando conexão',
    qrDisponivel: Boolean(qrAtual),
    mongodb: mongoose.connection.readyState === 1
      ? 'conectado'
      : 'desconectado'
  });
});

// Envia uma imagem para o grupo indicado.
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

  if (typeof foto !== 'string' || foto.length > 2048) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe a URL HTTPS da imagem.'
    });
  }

  let fotoUrl;

  try {
    fotoUrl = new URL(foto);
  } catch (_) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A URL da imagem é inválida.'
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

  if (
    legenda !== undefined &&
    (typeof legenda !== 'string' || legenda.length > 4096)
  ) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A legenda deve ter até 4096 caracteres.'
    });
  }

  if (!whatsappConectado || !client) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'WhatsApp ainda não está conectado.'
    });
  }

  try {
    const media = await MessageMedia.fromUrl(
      fotoUrl.toString()
    );

    await client.sendMessage(
      grupo.trim(),
      media,
      { caption: legenda || '' }
    );

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo.'
    });
  } catch (error) {
    console.error(
      '[Envio] Erro ao enviar mensagem:',
      error.message || error
    );

    return res.status(500).json({
      status: 'erro',
      mensagem: 'Falha ao enviar mensagem.'
    });
  }
});

// Inicia o servidor HTTP sem esperar pelo WhatsApp.
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Servidor] Rodando na porta ${PORT}`);
});

// Conecta ao banco, verifica a sessão e inicializa o WhatsApp.
async function iniciarWhatsApp() {
  console.log('[MongoDB] Iniciando conexão...');

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });

  console.log('[MongoDB] Conectado.');

  // Diagnóstico da sessão remota no banco.
  const store = new MongoStore({ mongoose });

  console.log(
    '[RemoteAuth] Verificando sessão:',
    REMOTE_SESSION_NAME
  );

  const sessaoExiste = await store.sessionExists({
    session: REMOTE_SESSION_NAME
  });

  console.log(
    '[RemoteAuth] Sessão remota encontrada:',
    sessaoExiste
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  // Registra o carregamento da página do WhatsApp Web.
  client.on('loading_screen', (percent, message) => {
    console.log(
      `[WhatsApp] Carregando: ${percent}% - ${message}`
    );
  });

  // Registra mudanças de estado.
  client.on('change_state', (state) => {
    console.log('[WhatsApp] Estado:', state);
  });

  // QR Code novo.
  client.on('qr', (qr) => {
    limparAvisoInicializacao();

    qrAtual = qr;
    whatsappConectado = false;

    console.log('[WhatsApp] Novo QR Code disponível em /qr.');
    qrcodeTerminal.generate(qr, { small: true });
  });

  // Autenticação.
  client.on('authenticated', () => {
    qrAtual = null;
    console.log('[WhatsApp] Autenticado com sucesso.');
  });

  // WhatsApp pronto para uso.
  client.on('ready', () => {
    limparAvisoInicializacao();

    qrAtual = null;
    whatsappConectado = true;

    console.log('[WhatsApp] Conectado e pronto para uso.');
  });

  // Confirma a gravação da sessão remota.
  client.on('remote_session_saved', () => {
    console.log('[RemoteAuth] Sessão salva no MongoDB.');
  });

  // Falha ao restaurar ou autenticar a sessão.
  client.on('auth_failure', (message) => {
    whatsappConectado = false;
    qrAtual = null;

    console.error(
      '[WhatsApp] Falha na autenticação:',
      message
    );
  });

  // Desconexão do WhatsApp.
  client.on('disconnected', (reason) => {
    whatsappConectado = false;
    qrAtual = null;

    console.warn('[WhatsApp] Desconectado:', reason);
  });

  // Outros erros emitidos pelo cliente.
  client.on('error', (error) => {
    console.error(
      '[WhatsApp] Erro do cliente:',
      error.message || error
    );
  });

  // Aviso caso o cliente não gere QR nem fique pronto.
  startupWatchdog = setTimeout(() => {
    console.warn(
      '[WhatsApp] Ainda aguardando QR Code ou evento ready. ' +
      'Confira as mensagens de carregamento acima.'
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
  limparAvisoInicializacao();

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
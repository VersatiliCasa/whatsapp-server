
'use strict';

const { Client, MessageMedia, RemoteAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { timingSafeEqual } = require('crypto');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');

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
    `Variáveis obrigatórias ausentes: ${missingEnv.join(', ')}`
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

const chromePath = puppeteer.executablePath();

console.log('Caminho do Chrome:', chromePath);
console.log('Chrome existe:', fs.existsSync(chromePath));

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome não encontrado: ${chromePath}`);
}

let qrAtual = null;
let whatsappConectado = false;
let client = null;
let encerrando = false;

function tokenCorreto(recebido, esperado) {
  if (
    typeof recebido !== 'string' ||
    typeof esperado !== 'string'
  ) {
    return false;
  }

  const recebidoBuffer = Buffer.from(recebido, 'utf8');
  const esperadoBuffer = Buffer.from(esperado, 'utf8');

  if (
    recebidoBuffer.length === 0 ||
    recebidoBuffer.length !== esperadoBuffer.length
  ) {
    return false;
  }

  return timingSafeEqual(recebidoBuffer, esperadoBuffer);
}

function envioAutorizado(req) {
  const cabecalho = req.get('authorization') || '';
  const resultado = cabecalho.match(/^Bearer\s+(.+)$/i);

  if (!resultado) return false;

  return tokenCorreto(
    resultado[1],
    process.env.WHATSAPP_API_TOKEN
  );
}

// Página inicial
app.get('/', (req, res) => {
  res.status(200).send('Servidor WhatsApp ativo.');
});

// Página protegida do QR Code
app.get('/qr', async (req, res) => {
  if (!tokenCorreto(req.query.token, process.env.QR_TOKEN)) {
    return res.status(401).send('Acesso não autorizado.');
  }

  res.setHeader(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, private'
  );

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
        <p>O código pode expirar. Aguarde a atualização da página.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error.message || error);
    return res.status(500).send('Erro ao gerar a imagem do QR Code.');
  }
});

// Status do servidor
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

// Envio protegido por token
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
    const media = await MessageMedia.fromUrl(fotoUrl.toString());

    await client.sendMessage(grupo.trim(), media, {
      caption: legenda || ''
    });

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo.'
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.message || error);

    return res.status(500).json({
      status: 'erro',
      mensagem: 'Falha ao enviar mensagem.'
    });
  }
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

async function iniciarWhatsApp() {
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000
  });

  console.log('MongoDB conectado.');

  const store = new MongoStore({ mongoose });

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      clientId: 'versatili-whatsapp',
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

  client.on('qr', (qr) => {
    qrAtual = qr;
    whatsappConectado = false;

    console.log('Novo QR Code disponível na página /qr.');
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    qrAtual = null;
    console.log('WhatsApp autenticado com sucesso.');
  });

  client.on('ready', () => {
    qrAtual = null;
    whatsappConectado = true;
    console.log('WhatsApp conectado e pronto para uso!');
  });

  client.on('remote_session_saved', () => {
    console.log('Sessão do WhatsApp salva no MongoDB.');
  });

  client.on('auth_failure', (message) => {
    whatsappConectado = false;
    qrAtual = null;
    console.error('Falha na autenticação do WhatsApp:', message);
  });

  client.on('disconnected', (reason) => {
    whatsappConectado = false;
    qrAtual = null;
    console.warn('WhatsApp desconectado:', reason);
  });

  await client.initialize();
}

iniciarWhatsApp().catch((error) => {
  console.error(
    'Erro ao inicializar WhatsApp/MongoDB:',
    error.message || error
  );
});

async function encerrarServidor() {
  if (encerrando) return;

  encerrando = true;
  console.log('Encerrando servidor...');

  try {
    if (client) {
      await client.destroy();
    }
  } catch (error) {
    console.error(
      'Erro ao encerrar o cliente WhatsApp:',
      error.message || error
    );
  }

  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } catch (error) {
    console.error(
      'Erro ao desconectar do MongoDB:',
      error.message || error
    );
  }

  server.close(() => process.exit(0));
}

process.on('SIGTERM', encerrarServidor);
process.on('SIGINT', encerrarServidor);

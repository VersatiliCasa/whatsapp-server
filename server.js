
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const chromePath = puppeteer.executablePath();

console.log('Caminho do Chrome:', chromePath);
console.log('Chrome encontrado:', fs.existsSync(chromePath));

if (!fs.existsSync(chromePath)) {
  throw new Error(
    `Chrome não encontrado: ${chromePath}. Verifique o build do Render.`
  );
}

const client = new Client({
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

client.on('qr', qr => {
  console.log('Escaneie o QR Code abaixo com o WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp autenticado.');
});

client.on('ready', () => {
  console.log('WhatsApp conectado!');
});

client.on('auth_failure', message => {
  console.error('Falha na autenticação:', message);
});

client.on('disconnected', reason => {
  console.log('WhatsApp desconectado:', reason);
});

app.get('/', (req, res) => {
  res.send('Servidor WhatsApp ativo.');
});

app.get('/status', (req, res) => {
  res.json({
    servidor: 'online',
    whatsapp: client.info ? 'conectado' : 'aguardando conexão'
  });
});

app.post('/enviar', async (req, res) => {
  const { grupo, foto, legenda } = req.body || {};

  if (!grupo || !foto) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe grupo e URL da foto.'
    });
  }

  if (!client.info) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'WhatsApp ainda não está conectado.'
    });
  }

  try {
    const media = await MessageMedia.fromUrl(foto);

    await client.sendMessage(grupo, media, {
      caption: legenda || ''
    });

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo.'
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);

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

client.initialize().catch(error => {
  console.error('Erro ao inicializar WhatsApp:', error);
});

process.on('SIGTERM', async () => {
  try {
    await client.destroy();
  } catch (error) {
    console.error('Erro ao encerrar WhatsApp:', error);
  }

  server.close(() => process.exit(0));
});

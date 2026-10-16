const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const client = new Client({
  puppeteer: {
    executablePath: puppeteer.executablePath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp conectado!');
});

client.on('auth_failure', msg => {
  console.error('Falha na autenticação do WhatsApp:', msg);
});

client.on('disconnected', reason => {
  console.log('WhatsApp desconectado:', reason);
});

app.post('/enviar', async (req, res) => {
  const { grupo, foto, legenda } = req.body;

  if (!grupo || !foto) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe o grupo e a URL da foto'
    });
  }

  try {
    const media = await MessageMedia.fromUrl(foto);

    await client.sendMessage(grupo, media, {
      caption: legenda || ''
    });

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo'
    });
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);

    return res.status(500).json({
      status: 'erro',
      mensagem: 'Falha ao enviar mensagem'
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

client.initialize().catch(error => {
  console.error('Erro ao inicializar o WhatsApp:', error);
});

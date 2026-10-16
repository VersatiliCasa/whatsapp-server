const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const puppeteer = require('puppeteer'); // Importar puppeteer diretamente
const app = express();
app.use(express.json());

const client = new Client({
  puppeteer: {
    executablePath: puppeteer.executablePath(), // força usar o Chromium baixado
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('WhatsApp conectado!'));
client.initialize();

app.post('/enviar', async (req, res) => {
  const { grupo, foto, legenda } = req.body;
  try {
    const media = await MessageMedia.fromUrl(foto);
    await client.sendMessage(grupo, media, { caption: legenda });
    res.json({ status: 'ok', mensagem: 'Mensagem enviada ao grupo' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: 'erro', mensagem: 'Falha ao enviar mensagem' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

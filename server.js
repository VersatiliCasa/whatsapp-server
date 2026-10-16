const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode'); // biblioteca para gerar imagem
const express = require('express');
const puppeteer = require('puppeteer'); // usar puppeteer completo
const app = express();
app.use(express.json());

const client = new Client({
  puppeteer: {
    executablePath: puppeteer.executablePath(), // força usar o Chromium baixado
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => {
  // Mostra no terminal em ASCII (opcional)
  qrcodeTerminal.generate(qr, { small: true });

  // Cria endpoint /qr para exibir QR como imagem
  QRCode.toDataURL(qr, (err, url) => {
    if (!err) {
      app.get('/qr', (req, res) => {
        res.send(`<h1>Escaneie o QR Code abaixo:</h1><img src="${url}" />`);
      });
      console.log("QR Code disponível em /qr");
    }
  });
});

client.on('ready', () => console.log('WhatsApp conectado!'));
client.initialize();

// Endpoint para enviar mensagens com foto + legenda
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

// Porta definida pelo Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

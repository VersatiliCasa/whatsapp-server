const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();
app.use(express.json());

// Configuração do Puppeteer para Render
const client = new Client({
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
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

// Usar a porta definida pelo Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));

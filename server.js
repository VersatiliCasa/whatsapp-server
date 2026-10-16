const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const app = express();
app.use(express.json());

const client = new Client();
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('WhatsApp conectado!'));
client.initialize();

app.post('/enviar', async (req, res) => {
  const { grupo, foto, legenda } = req.body;
  const media = await MessageMedia.fromUrl(foto);
  await client.sendMessage(grupo, media, { caption: legenda });
  res.json({ status: 'ok', mensagem: 'Mensagem enviada ao grupo' });
});

app.listen(3000, () => console.log('Servidor rodando na porta 3000'));


const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Localiza o Chrome instalado pelo Puppeteer
const chromePath = puppeteer.executablePath();

console.log('Caminho do Chrome:', chromePath);
console.log('Chrome existe:', fs.existsSync(chromePath));

if (!fs.existsSync(chromePath)) {
  console.error(
    'Chrome não encontrado. Verifique o package.json e o arquivo .puppeteerrc.cjs.'
  );
  process.exit(1);
}

// Inicializa o cliente do WhatsApp
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

// Eventos do WhatsApp
client.on('qr', qr => {
  console.log('Escaneie o QR Code com seu WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('WhatsApp autenticado com sucesso.');
});

client.on('ready', () => {
  console.log('WhatsApp conectado e pronto para uso!');
});

client.on('auth_failure', message => {
  console.error('Falha na autenticação do WhatsApp:', message);
});

client.on('disconnected', reason => {
  console.log('WhatsApp desconectado:', reason);
});

// Rota principal para verificar o servidor
app.get('/', (req, res) => {
  res.status(200).send('Servidor WhatsApp ativo.');
});

// Rota para verificar o status
app.get('/status', (req, res) => {
  res.json({
    servidor: 'online',
    whatsapp: client.info ? 'conectado' : 'aguardando conexão'
  });
});

// Rota para enviar imagem a um grupo
app.post('/enviar', async (req, res) => {
  const { grupo, foto, legenda } = req.body || {};

  if (!grupo || !foto) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe o identificador do grupo e a URL da foto.'
    });
  }

  if (!client.info) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'O WhatsApp ainda não está conectado.'
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

// Inicia o servidor HTTP
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

// Inicializa o WhatsApp
client.initialize().catch(error => {
  console.error('Erro ao inicializar o WhatsApp:', error);
});

// Encerramento do processo
process.on('SIGTERM', async () => {
  console.log('Encerrando servidor...');

  try {
    await client.destroy();
  } catch (error) {
    console.error('Erro ao encerrar o WhatsApp:', error);
  }

  server.close(() => {
    process.exit(0);
  });
});

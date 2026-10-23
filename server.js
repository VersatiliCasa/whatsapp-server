
const { Client, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const { timingSafeEqual } = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Verifica o Chrome instalado pelo Puppeteer
const chromePath = puppeteer.executablePath();

console.log('Caminho do Chrome:', chromePath);
console.log('Chrome existe:', fs.existsSync(chromePath));

if (!fs.existsSync(chromePath)) {
  throw new Error(`Chrome não encontrado: ${chromePath}`);
}

// Guarda o QR Code atual temporariamente
let qrAtual = null;
let whatsappConectado = false;

// Página inicial
app.get('/', (req, res) => {
  res.status(200).send('Servidor WhatsApp ativo.');
});

// Página protegida para exibir o QR Code
app.get('/qr', async (req, res) => {
  const token = process.env.QR_TOKEN;

  if (!token || req.query.token !== token) {
    return res.status(401).send('Acesso não autorizado.');
  }

  if (whatsappConectado) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>WhatsApp conectado</title>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h2>WhatsApp conectado!</h2>
        <p>Seu dispositivo já está autenticado.</p>
      </body>
      </html>
    `);
  }

  if (!qrAtual) {
    return res.status(503).send(`
      <html lang="pt-BR">
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="5">
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

    res.setHeader('Cache-Control', 'no-store');

    return res.send(`
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
        <p>O código pode expirar. Se necessário, atualize a página.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('Erro ao gerar QR Code:', error);
    return res.status(500).send('Erro ao gerar a imagem do QR Code.');
  }
});

// Estado do servidor
app.get('/status', (req, res) => {
  res.json({
    servidor: 'online',
    whatsapp: whatsappConectado ? 'conectado' : 'aguardando conexão',
    qrDisponivel: Boolean(qrAtual)
  });
});

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

// Recebe novos QR Codes
client.on('qr', qr => {
  qrAtual = qr;
  whatsappConectado = false;

  console.log('Novo QR Code disponível na página protegida /qr.');

  // Mantém o QR no log como alternativa
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

client.on('auth_failure', message => {
  console.error('Falha na autenticação:', message);
});

client.on('disconnected', reason => {
  whatsappConectado = false;
  qrAtual = null;
  console.log('WhatsApp desconectado:', reason);
});

// Envia imagem para um grupo — exige autenticação servidor a servidor
app.post('/enviar', async (req, res) => {
  const expectedToken = process.env.WHATSAPP_API_TOKEN;

  if (!expectedToken) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'Autenticação do serviço não configurada.'
    });
  }

  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      status: 'erro',
      mensagem: 'Acesso não autorizado.'
    });
  }

  const provided = Buffer.from(match[1].trim(), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return res.status(401).json({
      status: 'erro',
      mensagem: 'Acesso não autorizado.'
    });
  }

  const { grupo, foto, legenda } = req.body || {};

  if (
    typeof grupo !== 'string' || !grupo.trim() ||
    typeof foto !== 'string' || !foto.trim()
  ) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe grupo e URL da foto.'
    });
  }

  try {
    const imageUrl = new URL(foto);

    if (imageUrl.protocol !== 'https:') {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'A imagem precisa usar uma URL HTTPS.'
      });
    }
  } catch {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'A URL da foto é inválida.'
    });
  }

  if (!whatsappConectado) {
    return res.status(503).json({
      status: 'erro',
      mensagem: 'WhatsApp ainda não está conectado.'
    });
  }

  try {
    const media = await MessageMedia.fromUrl(foto);

    await client.sendMessage(grupo.trim(), media, {
      caption: typeof legenda === 'string' ? legenda : ''
    });

    return res.json({
      status: 'ok',
      mensagem: 'Mensagem enviada ao grupo.'
    });
  } catch (error) {
    console.error(
      'Erro ao enviar mensagem:',
      error instanceof Error ? error.name : 'erro desconhecido'
    );

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

// Inicializa o WhatsApp depois de iniciar o servidor
client.initialize().catch(error => {
  console.error('Erro ao inicializar WhatsApp:', error);
});

// Encerramento
process.on('SIGTERM', async () => {
  console.log('Encerrando servidor...');

  try {
    await client.destroy();
  } catch (error) {
    console.error('Erro ao encerrar WhatsApp:', error);
  }

  server.close(() => process.exit(0));
});

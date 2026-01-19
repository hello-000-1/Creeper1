import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pino from 'pino';
import pkg from 'google-libphonenumber';
const { PhoneNumberUtil } = pkg;
const phoneUtil = PhoneNumberUtil.getInstance();

import {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  makeWASocket
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import NodeCache from 'node-cache';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
let globalConn = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let pairingCode = null;

// Configuración de Express
app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

// Ruta principal
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// API para obtener estado
app.get('/api/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qr: qrCodeData,
    code: pairingCode,
    connected: globalConn?.user ? true : false,
    user: globalConn?.user
  });
});

// API para solicitar código de emparejamiento
app.post('/api/request-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Número de teléfono requerido' });
    }

    // Validar número
    let formattedNumber = phoneNumber.replace(/\D/g, '');
    if (!formattedNumber.startsWith('+')) {
      formattedNumber = `+${formattedNumber}`;
    }

    const isValid = await isValidPhoneNumber(formattedNumber);
    if (!isValid) {
      return res.status(400).json({ error: 'Número de teléfono inválido' });
    }

    // Eliminar el símbolo + para la solicitud
    const cleanNumber = formattedNumber.replace(/\D/g, '');

    if (globalConn && !globalConn.authState.creds.registered) {
      const code = await globalConn.requestPairingCode(cleanNumber);
      pairingCode = code?.match(/.{1,4}/g)?.join("-") || code;
      
      io.emit('pairing-code', pairingCode);
      
      res.json({ 
        success: true, 
        code: pairingCode,
        message: 'Código generado exitosamente'
      });
    } else {
      res.status(400).json({ error: 'Bot ya conectado o no disponible' });
    }
  } catch (error) {
    console.error('Error generando código:', error);
    res.status(500).json({ error: 'Error al generar código de emparejamiento' });
  }
});

// API para desconectar
app.post('/api/disconnect', async (req, res) => {
  try {
    if (globalConn) {
      await globalConn.logout();
      globalConn = null;
      qrCodeData = null;
      pairingCode = null;
      connectionStatus = 'disconnected';
      io.emit('status-update', { status: 'disconnected' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para reiniciar conexión
app.post('/api/restart', async (req, res) => {
  try {
    if (globalConn) {
      await globalConn.ws.close();
    }
    await startWhatsAppConnection();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Función para validar número de teléfono
async function isValidPhoneNumber(number) {
  try {
    number = number.replace(/\s+/g, '');
    if (number.startsWith('+521')) number = number.replace('+521', '+52');
    else if (number.startsWith('+52') && number[4] === '1') {
      number = number.replace('+52 1', '+52');
    }
    const parsedNumber = phoneUtil.parseAndKeepRawInput(number);
    return phoneUtil.isValidNumber(parsedNumber);
  } catch {
    return false;
  }
}

// Función para iniciar conexión de WhatsApp
async function startWhatsAppConnection() {
  const sessions = './blackSession';
  const msgRetryCounterCache = new NodeCache();
  const { state, saveCreds } = await useMultiFileAuthState(sessions);
  const { version } = await fetchLatestBaileysVersion();

  const connectionOptions = {
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Black Clover Bot', 'Chrome', '120.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
    },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    msgRetryCounterCache,
    defaultQueryTimeoutMs: undefined,
    version
  };

  globalConn = makeWASocket(connectionOptions);

  // Manejo de QR
  globalConn.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrCodeData = qr;
      pairingCode = null;
      io.emit('qr-code', qr);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      connectionStatus = 'disconnected';
      io.emit('status-update', { 
        status: 'disconnected', 
        reason: DisconnectReason[reason] || 'unknown' 
      });

      // Reconectar si no fue logout
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => startWhatsAppConnection(), 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      pairingCode = null;
      
      io.emit('status-update', { 
        status: 'connected',
        user: globalConn.user
      });
      
      console.log('✅ Bot conectado exitosamente');
      console.log('Usuario:', globalConn.user);
    } else if (connection === 'connecting') {
      connectionStatus = 'connecting';
      io.emit('status-update', { status: 'connecting' });
    }
  });

  // Guardar credenciales
  globalConn.ev.on('creds.update', saveCreds);

  // Mensajes
  globalConn.ev.on('messages.upsert', ({ messages }) => {
    const msg = messages[0];
    if (msg) {
      io.emit('new-message', {
        from: msg.key.remoteJid,
        message: msg.message,
        timestamp: msg.messageTimestamp
      });
    }
  });
}

// Socket.IO para comunicación en tiempo real
io.on('connection', (socket) => {
  console.log('Cliente web conectado');
  
  // Enviar estado actual
  socket.emit('status-update', { 
    status: connectionStatus,
    user: globalConn?.user
  });
  
  if (qrCodeData) {
    socket.emit('qr-code', qrCodeData);
  }
  
  if (pairingCode) {
    socket.emit('pairing-code', pairingCode);
  }

  socket.on('disconnect', () => {
    console.log('Cliente web desconectado');
  });
});

// Iniciar servidor
server.listen(PORT, async () => {
  console.log(`🌐 Servidor web corriendo en http://localhost:${PORT}`);
  console.log('🤖 Iniciando conexión de WhatsApp...');
  await startWhatsAppConnection();
});

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
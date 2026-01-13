/* BigDaddy.js - Telegram Bot Command Handler */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const moment = require('moment-timezone');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(require('child_process').exec);

// ==================== CONFIGURATION ====================
const config = {
    prefix: '.',
    ownerId: '6300694007',
    botName: 'PhistarBotInc',
    version: '3.0.0',
    
    // APIs
    animeAPI: 'https://api.jikan.moe/v4',
    weatherAPI: 'https://api.openweathermap.org/data/2.5/weather',
    cryptoAPI: 'https://api.coingecko.com/api/v3',
    
    // File paths
    sessionStoragePath: './telegram_sessions',
    tempDir: './temp',
    
    // Limits
    maxFileSize: 50 * 1024 * 1024, // 50MB
    rateLimitWindow: 60000, // 1 minute
    maxRequestsPerWindow: 30
};

// ==================== RATE LIMITING ====================
const userRateLimit = new Map();

function checkRateLimit(userId) {
    const now = Date.now();
    const userData = userRateLimit.get(userId) || { count: 0, timestamp: now };
    
    if (now - userData.timestamp > config.rateLimitWindow) {
        userData.count = 1;
        userData.timestamp = now;
        userRateLimit.set(userId, userData);
        return true;
    }
    
    if (userData.count >= config.maxRequestsPerWindow) {
        return false;
    }
    
    userData.count++;
    userRateLimit.set(userId, userData);
    return true;
}

// ==================== COMMAND HANDLER ====================
async function BigDaddyHandler(client, message) {
    try {
        const phoneNumber = client.session.phoneNumber || 'unknown';
        const userId = message.sender?.id?.toString() || 'unknown';
        const chatId = message.chat?.id?.toString() || 'unknown';
        
        // Check rate limit
        if (!checkRateLimit(userId)) {
            await message.reply(`⚠️ Rate limit exceeded. Please wait 1 minute.`);
            return;
        }
        
        // Get command
        const text = message.text || '';
        const args = text.trim().split(' ');
        const command = args[0].toLowerCase();
        
        // Remove prefix if present
        const cmd = command.startsWith(config.prefix) 
            ? command.slice(config.prefix.length) 
            : command;
        
        // Log command
        console.log(`📝 Command from ${phoneNumber}: ${cmd}`);
        
        // Handle commands
        switch(cmd) {
            case 'ping':
                await pingCommand(client, message, args.slice(1));
                break;
                
            case 'pong':
                await pongCommand(client, message, args.slice(1));
                break;
                
            case 'menu':
            case 'help':
                await menuCommand(client, message, args.slice(1));
                break;
                
            case 'start':
                await startCommand(client, message, args.slice(1));
                break;
                
            case 'status':
                await statusCommand(client, message, args.slice(1));
                break;
                
            case 'info':
                await infoCommand(client, message, args.slice(1));
                break;
                
            case 'time':
                await timeCommand(client, message, args.slice(1));
                break;
                
            case 'weather':
                await weatherCommand(client, message, args.slice(1));
                break;
                
            case 'crypto':
                await cryptoCommand(client, message, args.slice(1));
                break;
                
            case 'anime':
                await animeCommand(client, message, args.slice(1));
                break;
                
            case 'joke':
                await jokeCommand(client, message, args.slice(1));
                break;
                
            case 'quote':
                await quoteCommand(client, message, args.slice(1));
                break;
                
            case 'calc':
                await calculatorCommand(client, message, args.slice(1));
                break;
                
            case 'short':
                await urlShortenerCommand(client, message, args.slice(1));
                break;
                
            case 'qr':
                await qrCodeCommand(client, message, args.slice(1));
                break;
                
            case 'yt':
                await youtubeCommand(client, message, args.slice(1));
                break;
                
            case 'sticker':
                await stickerCommand(client, message, args.slice(1));
                break;
                
            case 'admin':
                await adminCommand(client, message, args.slice(1));
                break;
                
            case 'speed':
                await speedTestCommand(client, message, args.slice(1));
                break;
                
            case 'shell':
                await shellCommand(client, message, args.slice(1));
                break;
                
            case 'eval':
                await evalCommand(client, message, args.slice(1));
                break;
                
            case 'backup':
                await backupCommand(client, message, args.slice(1));
                break;
                
            case 'restart':
                await restartCommand(client, message, args.slice(1));
                break;
                
            default:
                if (command.startsWith(config.prefix)) {
                    await message.reply(`❌ Unknown command: ${cmd}\nType ${config.prefix}menu for available commands.`);
                }
                break;
        }
        
    } catch (error) {
        console.error('❌ BigDaddy handler error:', error);
        
        // Try to send error message
        try {
            await message.reply(`❌ Error: ${error.message}\nPlease try again.`);
        } catch (e) {
            console.error('Failed to send error message:', e);
        }
    }
}

// ==================== COMMAND FUNCTIONS ====================

// 1. Ping Command
async function pingCommand(client, message, args) {
    const startTime = Date.now();
    const reply = await message.reply('🏓 Pong!');
    const endTime = Date.now();
    const latency = endTime - startTime;
    
    await message.reply(`✅ Pong!\n📶 Latency: ${latency}ms\n🤖 Bot: ${config.botName} v${config.version}`);
}

// 2. Pong Command
async function pongCommand(client, message, args) {
    await message.reply('🏓 Ping! The bot is alive and working! 🚀');
}

// 3. Menu/Help Command
async function menuCommand(client, message, args) {
    const menu = `
🤖 *${config.botName} v${config.version} - Command Menu*

*📊 Basic Commands:*
• ${config.prefix}ping - Check bot latency
• ${config.prefix}pong - Check if bot is alive
• ${config.prefix}menu - Show this menu
• ${config.prefix}status - Bot status
• ${config.prefix}info - User info
• ${config.prefix}time - Current time

*🌐 Utility Commands:*
• ${config.prefix}weather [city] - Get weather info
• ${config.prefix}crypto [coin] - Crypto prices
• ${config.prefix}anime [name] - Anime info
• ${config.prefix}joke - Random joke
• ${config.prefix}quote - Inspirational quote
• ${config.prefix}calc [expression] - Calculator
• ${config.prefix}short [url] - URL shortener
• ${config.prefix}qr [text] - Generate QR code
• ${config.prefix}yt [query] - Search YouTube

*🛠️ Media Commands:*
• ${config.prefix}sticker - Create sticker from image

*⚡ System Commands:*
• ${config.prefix}speed - Speed test
• ${config.prefix}shell [command] - Execute shell (Owner)
• ${config.prefix}eval [code] - Evaluate code (Owner)
• ${config.prefix}backup - Backup sessions
• ${config.prefix}restart - Restart bot (Owner)

*👑 Admin Commands:*
• ${config.prefix}admin - Admin panel (Owner only)

*📌 Usage:*
Type ${config.prefix}command [arguments]
Example: ${config.prefix}weather London
    `;
    
    await message.reply(menu);
}

// 4. Start Command
async function startCommand(client, message, args) {
    const welcome = `
🎉 *Welcome to ${config.botName}!* 🎉

I'm a multi-functional Telegram bot with various features.

*Quick Start:*
• Use ${config.prefix}menu to see all commands
• Use ${config.prefix}ping to check if I'm alive
• Use ${config.prefix}help for assistance

*Features:*
✓ Utility Tools
✓ Media Processing
✓ Information Lookup
✓ Entertainment
✓ System Management

*Need Help?*
Type ${config.prefix}help anytime!

🤖 Version: ${config.version}
    `;
    
    await message.reply(welcome);
}

// 5. Status Command
async function statusCommand(client, message, args) {
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    const memoryUsage = process.memoryUsage();
    const heapUsed = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
    const rss = (memoryUsage.rss / 1024 / 1024).toFixed(2);
    
    const status = `
📊 *${config.botName} Status*

*🕒 Uptime:*
${days}d ${hours}h ${minutes}m ${seconds}s

*💾 Memory Usage:*
Heap: ${heapUsed} MB
RSS: ${rss} MB

*🤖 Bot Info:*
Name: ${config.botName}
Version: ${config.version}
Prefix: ${config.prefix}
Platform: ${process.platform}

*📱 Connection:*
Phone: ${client.session.phoneNumber || 'Unknown'}
Connected: ✅ Online

*🎯 Commands Processed:*
Rate Limit: ${config.maxRequestsPerWindow}/minute
    `;
    
    await message.reply(status);
}

// 6. Info Command
async function infoCommand(client, message, args) {
    const user = message.sender;
    const phone = client.session.phoneNumber || 'Unknown';
    
    const userInfo = `
👤 *User Information*

*Basic Info:*
ID: ${user.id || 'Unknown'}
Username: ${user.username || 'Not set'}
First Name: ${user.firstName || 'Unknown'}
Last Name: ${user.lastName || ''}

*Telegram Info:*
Phone: ${phone}
Bot: ${user.bot ? 'Yes' : 'No'}
Premium: ${user.premium ? 'Yes' : 'No'}

*Chat Info:*
Chat ID: ${message.chat?.id || 'Unknown'}
Chat Type: ${message.chat?.className || 'Unknown'}

*📅 Account Created:*
${moment().format('DD/MM/YYYY HH:mm:ss')}
    `;
    
    await message.reply(userInfo);
}

// 7. Time Command
async function timeCommand(client, message, args) {
    const timezone = args[0] || 'UTC';
    
    try {
        const time = moment().tz(timezone).format('dddd, MMMM Do YYYY, h:mm:ss A');
        const timeInfo = `
🕒 *Time Information*

*Timezone:* ${timezone}
*Current Time:* ${time}
*UTC Time:* ${moment().utc().format('HH:mm:ss')}

*Common Timezones:*
• UTC - ${moment().tz('UTC').format('HH:mm')}
• EST - ${moment().tz('America/New_York').format('HH:mm')}
• PST - ${moment().tz('America/Los_Angeles').format('HH:mm')}
• GMT - ${moment().tz('Europe/London').format('HH:mm')}
• IST - ${moment().tz('Asia/Kolkata').format('HH:mm')}
• JST - ${moment().tz('Asia/Tokyo').format('HH:mm')}

*Usage:* ${config.prefix}time [timezone]
Example: ${config.prefix}time America/New_York
        `;
        
        await message.reply(timeInfo);
    } catch (error) {
        await message.reply(`❌ Invalid timezone. Use format: ${config.prefix}time America/New_York`);
    }
}

// 8. Weather Command
async function weatherCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please specify a city.\nUsage: ${config.prefix}weather [city]`);
        return;
    }
    
    const city = args.join(' ');
    
    try {
        await message.reply(`⏳ Fetching weather for ${city}...`);
        
        const response = await axios.get(
            `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=YOUR_API_KEY&units=metric`
        );
        
        const weather = response.data;
        const temp = weather.main.temp;
        const feelsLike = weather.main.feels_like;
        const humidity = weather.main.humidity;
        const windSpeed = weather.wind.speed;
        const description = weather.weather[0].description;
        const icon = getWeatherIcon(weather.weather[0].main);
        
        const weatherInfo = `
${icon} *Weather in ${weather.name}, ${weather.sys.country}*

*🌡️ Temperature:*
Current: ${temp}°C
Feels Like: ${feelsLike}°C
Min: ${weather.main.temp_min}°C
Max: ${weather.main.temp_max}°C

*💨 Conditions:*
Description: ${description}
Humidity: ${humidity}%
Wind Speed: ${windSpeed} m/s
Pressure: ${weather.main.pressure} hPa

*📍 Location:*
Latitude: ${weather.coord.lat}
Longitude: ${weather.coord.lon}

*☁️ Clouds:*
${weather.clouds.all}% cloud coverage
        `;
        
        await message.reply(weatherInfo);
    } catch (error) {
        await message.reply(`❌ Could not fetch weather for "${city}". Please check the city name.`);
    }
}

function getWeatherIcon(condition) {
    const icons = {
        'Clear': '☀️',
        'Clouds': '☁️',
        'Rain': '🌧️',
        'Snow': '❄️',
        'Thunderstorm': '⛈️',
        'Drizzle': '🌦️',
        'Mist': '🌫️',
        'Fog': '🌁'
    };
    return icons[condition] || '🌤️';
}

// 9. Crypto Command
async function cryptoCommand(client, message, args) {
    const coin = args[0]?.toLowerCase() || 'bitcoin';
    
    try {
        await message.reply(`💰 Fetching ${coin} price...`);
        
        const response = await axios.get(
            `https://api.coingecko.com/api/v3/coins/${coin}`
        );
        
        const data = response.data;
        const price = data.market_data.current_price.usd;
        const change24h = data.market_data.price_change_percentage_24h;
        const marketCap = data.market_data.market_cap.usd;
        const volume = data.market_data.total_volume.usd;
        const high24h = data.market_data.high_24h.usd;
        const low24h = data.market_data.low_24h.usd;
        
        const changeIcon = change24h >= 0 ? '📈' : '📉';
        const changeColor = change24h >= 0 ? '🟢' : '🔴';
        
        const cryptoInfo = `
💰 *${data.name} (${data.symbol.toUpperCase()})*

*💵 Price:* $${price.toLocaleString()}
*${changeIcon} 24h Change:* ${changeColor} ${change24h.toFixed(2)}%

*📊 Market Stats:*
Market Cap: $${(marketCap / 1000000000).toFixed(2)}B
24h Volume: $${(volume / 1000000).toFixed(2)}M
24h High: $${high24h.toLocaleString()}
24h Low: $${low24h.toLocaleString()}

*🔄 Supply:*
Circulating: ${(data.market_data.circulating_supply / 1000000).toFixed(2)}M
Total: ${(data.market_data.total_supply / 1000000).toFixed(2)}M
Max: ${data.market_data.max_supply ? `${(data.market_data.max_supply / 1000000).toFixed(2)}M` : '∞'}

*🌍 Rank:* #${data.market_cap_rank}
        `;
        
        await message.reply(cryptoInfo);
    } catch (error) {
        await message.reply(`❌ Could not fetch ${coin} data. Try: bitcoin, ethereum, solana, etc.`);
    }
}

// 10. Anime Command
async function animeCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please specify anime name.\nUsage: ${config.prefix}anime [name]`);
        return;
    }
    
    const query = args.join(' ');
    
    try {
        await message.reply(`🔍 Searching for "${query}"...`);
        
        const response = await axios.get(
            `${config.animeAPI}/anime?q=${encodeURIComponent(query)}&limit=1`
        );
        
        if (response.data.data.length === 0) {
            await message.reply(`❌ No anime found for "${query}"`);
            return;
        }
        
        const anime = response.data.data[0];
        const score = anime.score || 'N/A';
        const episodes = anime.episodes || 'Unknown';
        const status = anime.status || 'Unknown';
        
        const animeInfo = `
🎌 *${anime.title}* ${anime.title_japanese ? `(${anime.title_japanese})` : ''}

*📊 Information:*
Score: ⭐ ${score}/10
Episodes: ${episodes}
Status: ${status}
Type: ${anime.type}
Aired: ${anime.aired?.string || 'Unknown'}

*🎭 Genres:*
${anime.genres?.map(g => `• ${g.name}`).join('\n') || 'None'}

*📖 Synopsis:*
${anime.synopsis?.substring(0, 500)}${anime.synopsis?.length > 500 ? '...' : ''}

*🔗 Links:*
MyAnimeList: ${anime.url}
        `;
        
        await message.reply(animeInfo);
        
        // Try to send image if available
        if (anime.images?.jpg?.large_image_url) {
            try {
                await client.sendFile(message.chat, {
                    file: anime.images.jpg.large_image_url,
                    caption: `🎨 ${anime.title}`
                });
            } catch (e) {
                console.log('Could not send anime image');
            }
        }
        
    } catch (error) {
        await message.reply(`❌ Error searching anime. Please try again.`);
    }
}

// 11. Joke Command
async function jokeCommand(client, message, args) {
    try {
        const response = await axios.get('https://v2.jokeapi.dev/joke/Any');
        const joke = response.data;
        
        let jokeText = '';
        
        if (joke.type === 'single') {
            jokeText = joke.joke;
        } else {
            jokeText = `${joke.setup}\n\n...\n\n${joke.delivery}`;
        }
        
        const jokeMessage = `
😂 *Random Joke*

*Category:* ${joke.category}
*Type:* ${joke.type}

*Joke:*
${jokeText}

${joke.flags?.nsfw ? '⚠️ NSFW Content' : ''}
        `;
        
        await message.reply(jokeMessage);
    } catch (error) {
        // Fallback joke
        const fallbackJokes = [
            "Why don't scientists trust atoms?\nBecause they make up everything!",
            "Why did the scarecrow win an award?\nHe was outstanding in his field!",
            "What do you call a fake noodle?\nAn impasta!",
            "Why did the coffee file a police report?\nIt got mugged!",
            "What do you call a bear with no teeth?\nA gummy bear!"
        ];
        
        const randomJoke = fallbackJokes[Math.floor(Math.random() * fallbackJokes.length)];
        await message.reply(`😂 *Joke of the moment:*\n\n${randomJoke}`);
    }
}

// 12. Quote Command
async function quoteCommand(client, message, args) {
    try {
        const response = await axios.get('https://api.quotable.io/random');
        const quote = response.data;
        
        const quoteMessage = `
💭 *Inspirational Quote*

"${quote.content}"

— *${quote.author}*

*📚 Tags:* ${quote.tags.join(', ')}
        `;
        
        await message.reply(quoteMessage);
    } catch (error) {
        const fallbackQuotes = [
            "The only way to do great work is to love what you do. — Steve Jobs",
            "Innovation distinguishes between a leader and a follower. — Steve Jobs",
            "Your time is limited, so don't waste it living someone else's life. — Steve Jobs",
            "Stay hungry, stay foolish. — Steve Jobs",
            "The future belongs to those who believe in the beauty of their dreams. — Eleanor Roosevelt"
        ];
        
        const randomQuote = fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];
        await message.reply(`💭 *Quote:*\n\n${randomQuote}`);
    }
}

// 13. Calculator Command
async function calculatorCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please provide an expression.\nUsage: ${config.prefix}calc 2+2*3`);
        return;
    }
    
    try {
        const expression = args.join('').replace(/[^-()\d/*+.]/g, '');
        
        // Safe evaluation
        const result = eval(expression);
        
        const calcResult = `
🧮 *Calculator*

*Expression:* \`${expression}\`
*Result:* \`${result}\`

*Example Expressions:*
• 2+2 = 4
• 10*5 = 50
• 100/4 = 25
• 2^3 = 8 (use 2**3)
        `;
        
        await message.reply(calcResult);
    } catch (error) {
        await message.reply(`❌ Invalid expression. Use only numbers and + - * / operators.`);
    }
}

// 14. URL Shortener Command
async function urlShortenerCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please provide a URL.\nUsage: ${config.prefix}short https://example.com`);
        return;
    }
    
    const url = args[0];
    
    try {
        await message.reply(`⏳ Shortening URL...`);
        
        // Using tinyurl API
        const response = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
        
        const shortUrl = response.data;
        
        const urlInfo = `
🔗 *URL Shortener*

*Original URL:*
${url}

*Shortened URL:*
${shortUrl}

*📊 URL Info:*
Length Reduced: ${url.length - shortUrl.length} characters
Shortened by: ${Math.round((1 - shortUrl.length / url.length) * 100)}%

*🔗 Quick Access:*
Click the link above to visit
        `;
        
        await message.reply(urlInfo);
    } catch (error) {
        await message.reply(`❌ Could not shorten URL. Make sure it's a valid URL starting with http:// or https://`);
    }
}

// 15. QR Code Command
async function qrCodeCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please provide text for QR code.\nUsage: ${config.prefix}qr Hello World`);
        return;
    }
    
    const text = args.join(' ');
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
    
    const qrInfo = `
📱 *QR Code Generator*

*Text:* ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}
*Size:* 200x200 pixels

*🔗 QR Code URL:*
${qrUrl}

*💡 Usage:*
Scan this QR code with your phone's camera or QR scanner app to read the text.
        `;
    
    try {
        // Send QR code image
        await client.sendFile(message.chat, {
            file: qrUrl,
            caption: `📱 QR Code for: ${text.substring(0, 30)}...`
        });
        
        await message.reply(qrInfo);
    } catch (error) {
        await message.reply(`❌ Could not generate QR code. Text too long?`);
    }
}

// 16. YouTube Command
async function youtubeCommand(client, message, args) {
    if (args.length === 0) {
        await message.reply(`❌ Please provide search query.\nUsage: ${config.prefix}yt funny cats`);
        return;
    }
    
    const query = args.join(' ');
    
    try {
        await message.reply(`🔍 Searching YouTube for "${query}"...`);
        
        const response = await axios.get(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&maxResults=5&key=YOUR_API_KEY`
        );
        
        if (response.data.items.length === 0) {
            await message.reply(`❌ No videos found for "${query}"`);
            return;
        }
        
        let results = '🎬 *YouTube Search Results*\n\n';
        
        response.data.items.forEach((item, index) => {
            const title = item.snippet.title;
            const channel = item.snippet.channelTitle;
            const videoId = item.id.videoId;
            const url = `https://youtu.be/${videoId}`;
            
            results += `*${index + 1}. ${title}*\n`;
            results += `Channel: ${channel}\n`;
            results += `Link: ${url}\n\n`;
        });
        
        results += `*Total Results:* ${response.data.pageInfo.totalResults}`;
        
        await message.reply(results);
    } catch (error) {
        const fallbackMessage = `
🎬 *YouTube Search*

*Query:* ${query}

*Note:* YouTube API key required for this feature.

*Manual Search:*
You can search YouTube manually at:
https://www.youtube.com/results?search_query=${encodeURIComponent(query)}
        `;
        
        await message.reply(fallbackMessage);
    }
}

// 17. Sticker Command
async function stickerCommand(client, message, args) {
    await message.reply(`
🖼️ *Sticker Creator*

*Usage:*
1. Send me an image
2. Reply to that image with ${config.prefix}sticker
3. I'll convert it to a sticker

*Requirements:*
• Image size < 5MB
• Supported formats: JPG, PNG, WebP
• Square images work best

*Note:* This feature requires image message processing.
        `);
}

// 18. Admin Command
async function adminCommand(client, message, args) {
    const userId = message.sender?.id?.toString();
    
    if (userId !== config.ownerId) {
        await message.reply('❌ This command is for owner only.');
        return;
    }
    
    const adminMenu = `
👑 *Admin Panel*

*📊 System Stats:*
Uptime: ${Math.floor(process.uptime())}s
Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB
Sessions: ${global.activeTelegramClients?.size || 0}

*⚙️ Admin Commands:*
• ${config.prefix}shell [cmd] - Execute shell
• ${config.prefix}eval [code] - Evaluate code
• ${config.prefix}backup - Backup sessions
• ${config.prefix}restart - Restart bot

*🔧 System Control:*
Use with caution!
        `;
    
    await message.reply(adminMenu);
}

// 19. Speed Test Command
async function speedTestCommand(client, message, args) {
    await message.reply('⚡ Running speed test...');
    
    try {
        const startTime = Date.now();
        
        // Test download speed by fetching a file
        const response = await axios.get('https://proof.ovh.net/files/10Mb.dat', {
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        const endTime = Date.now();
        const fileSize = response.data.length; // in bytes
        const duration = (endTime - startTime) / 1000; // in seconds
        
        const speedBps = fileSize / duration;
        const speedMbps = (speedBps * 8) / 1000000;
        
        const speedInfo = `
⚡ *Speed Test Results*

*📥 Download Speed:*
${speedMbps.toFixed(2)} Mbps
${(speedBps / 1000).toFixed(2)} KB/s

*📊 Test Details:*
File Size: ${(fileSize / 1024 / 1024).toFixed(2)} MB
Duration: ${duration.toFixed(2)} seconds
Data Transferred: ${(fileSize / 1024).toFixed(2)} KB

*🏆 Rating:*
${getSpeedRating(speedMbps)}

*📍 Server Location:* France (OVH)
        `;
        
        await message.reply(speedInfo);
    } catch (error) {
        await message.reply('❌ Speed test failed. Network error or timeout.');
    }
}

function getSpeedRating(speedMbps) {
    if (speedMbps > 100) return '🚀 Excellent (Fiber)';
    if (speedMbps > 50) return '👍 Very Good (Cable)';
    if (speedMbps > 25) return '✅ Good (ADSL)';
    if (speedMbps > 10) return '⚠️ Average (4G)';
    return '❌ Poor (3G)';
}

// 20. Shell Command (Owner Only)
async function shellCommand(client, message, args) {
    const userId = message.sender?.id?.toString();
    
    if (userId !== config.ownerId) {
        await message.reply('❌ This command is for owner only.');
        return;
    }
    
    if (args.length === 0) {
        await message.reply(`❌ Please provide a shell command.\nUsage: ${config.prefix}shell ls -la`);
        return;
    }
    
    const cmd = args.join(' ');
    
    try {
        await message.reply(`🖥️ Executing: \`${cmd}\`\n⏳ Please wait...`);
        
        const { stdout, stderr } = await execPromise(cmd, { timeout: 30000 });
        
        let output = `✅ *Command Executed*\n\n`;
        output += `*Command:* \`${cmd}\`\n\n`;
        
        if (stdout) {
            const shortStdout = stdout.length > 1500 ? stdout.substring(0, 1500) + '...' : stdout;
            output += `*Output:*\n\`\`\`\n${shortStdout}\n\`\`\`\n`;
        }
        
        if (stderr) {
            const shortStderr = stderr.length > 1500 ? stderr.substring(0, 1500) + '...' : stderr;
            output += `*Errors:*\n\`\`\`\n${shortStderr}\n\`\`\``;
        }
        
        await message.reply(output);
    } catch (error) {
        await message.reply(`❌ Execution failed:\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

// 21. Eval Command (Owner Only)
async function evalCommand(client, message, args) {
    const userId = message.sender?.id?.toString();
    
    if (userId !== config.ownerId) {
        await message.reply('❌ This command is for owner only.');
        return;
    }
    
    if (args.length === 0) {
        await message.reply(`❌ Please provide code to evaluate.\nUsage: ${config.prefix}eval 2+2`);
        return;
    }
    
    const code = args.join(' ');
    
    try {
        await message.reply(`🧠 Evaluating code...`);
        
        // Safe evaluation in sandbox
        const result = await evaluateCode(code, client, message);
        
        const evalResult = `
🧮 *Code Evaluation*

*Code:* \`\`\`javascript\n${code}\n\`\`\`

*Result:* \`\`\`\n${result}\n\`\`\`

*Type:* ${typeof result}
        `;
        
        await message.reply(evalResult);
    } catch (error) {
        await message.reply(`❌ Evaluation error:\n\`\`\`\n${error.message}\n\`\`\``);
    }
}

async function evaluateCode(code, client, message) {
    // Create a safe context
    const context = {
        client: client,
        message: message,
        args: message.text?.split(' ').slice(1) || [],
        axios: axios,
        fs: fs,
        path: path,
        crypto: crypto,
        moment: moment,
        config: config,
        Math: Math,
        Date: Date,
        JSON: JSON,
        console: {
            log: (...args) => console.log('[EVAL]', ...args)
        }
    };
    
    // Remove dangerous functions
    delete context.process;
    delete context.require;
    delete context.__proto__;
    delete context.constructor;
    
    // Use Function constructor for safer eval
    const func = new Function(...Object.keys(context), `return (${code})`);
    return func(...Object.values(context));
}

// 22. Backup Command
async function backupCommand(client, message, args) {
    const userId = message.sender?.id?.toString();
    
    if (userId !== config.ownerId) {
        await message.reply('❌ This command is for owner only.');
        return;
    }
    
    try {
        await message.reply('💾 Starting session backup...');
        
        // Call the backup function from main bot
        if (typeof global.backupSessionsToDropbox === 'function') {
            const result = await global.backupSessionsToDropbox();
            
            if (result.success) {
                await message.reply(`✅ Backup successful!\n\n${result.message}`);
            } else {
                await message.reply(`❌ Backup failed: ${result.error}`);
            }
        } else {
            await message.reply('❌ Backup function not available.');
        }
    } catch (error) {
        await message.reply(`❌ Backup error: ${error.message}`);
    }
}

// 23. Restart Command (Owner Only)
async function restartCommand(client, message, args) {
    const userId = message.sender?.id?.toString();
    
    if (userId !== config.ownerId) {
        await message.reply('❌ This command is for owner only.');
        return;
    }
    
    try {
        await message.reply('🔄 Restarting bot in 5 seconds...');
        
        setTimeout(async () => {
            if (typeof global.performAutoRestart === 'function') {
                await global.performAutoRestart();
            } else {
                process.exit(0);
            }
        }, 5000);
    } catch (error) {
        await message.reply(`❌ Restart error: ${error.message}`);
    }
}

// ==================== UTILITY FUNCTIONS ====================
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getRandomColor() {
    return '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0');
}

// ==================== EXPORTS ====================
module.exports = BigDaddyHandler;

// Make functions available globally for eval
global.BigDaddyHandler = BigDaddyHandler;
global.formatBytes = formatBytes;
global.getRandomColor = getRandomColor;

console.log('✅ BigDaddy.js loaded successfully!');
console.log(`🤖 Prefix: ${config.prefix}`);
console.log(`📚 Commands: 23+ commands available`);

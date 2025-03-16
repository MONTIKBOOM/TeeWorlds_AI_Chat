const teeworlds = require('teeworlds');
const fs = require('fs');
const readline = require('readline');
const colors = require('colors/safe');
const path = require('path');
const os = require('os');
const https = require('https');

const API_KEY = 'YOUR_API_KEY_HERE';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

let clients = [];
let totalMessagesSent = 0;
let reconnectAttempts = {};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Replace fetch with native Node.js https request
async function callApi(message, sender) {
  return new Promise((resolve, reject) => {
    try {
      console.log(colors.yellow(`🤔 Обдумываю ответ на сообщение ${colors.bold(sender)}...`));
      
      const postData = JSON.stringify({
        model: 'deepseek/deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'Ты полезный ассистент. Отвечай кратко (макс. 160 символов).'
          },
          {
            role: 'user',
            content: `Ответь на "${message}" на языке пользователя, макс. 160 символов, начни с ${sender}:, без эмодзи и эмоций`
          }
        ],
        max_tokens: 100
      });
      
      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const req = https.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`API Error: Status ${res.statusCode}`));
            return;
          }
          
          try {
            const responseData = JSON.parse(data);
            let reply = responseData.choices[0].message.content.trim();
            reply = reply.replace(/(\r\n|\n|\r)/gm, ' ').trim();
            const finalReply = reply.length > 160 ? reply.slice(0, 157) + '...' : reply;
            
            console.log(colors.green(`✅ Сгенерирован ответ: ${colors.italic(finalReply)}`));
            resolve(finalReply);
          } catch (err) {
            reject(new Error(`Failed to parse API response: ${err.message}`));
          }
        });
      });
      
      req.on('error', (err) => {
        reject(new Error(`API Request failed: ${err.message}`));
      });
      
      req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

function shouldProcessMessage(message) {
  if (!message || typeof message !== 'string') return false;
  
  const skipPatterns = [
    'our community', 'joined', 'left', 'entered', 'muted', 
    'not permitted', 'version', 'visit', 'rules', 'welcome',
    'server', 'spectator', 'connecting', 'disconnected'
  ];
  
  const lowercaseMsg = message.toLowerCase();
  
  if (skipPatterns.some(pattern => lowercaseMsg.includes(pattern))) return false;
  if (message.trim().length < 2) return false;
  if (message.startsWith('/') || message.startsWith('!')) return false;
  
  return true;
}

async function generateResponse(message, sender) {
  if (!shouldProcessMessage(message)) {
    console.log(colors.gray(`⏭️ Пропуск сообщения: "${message}" от ${sender}`));
    return null;
  }

  try {
    return await callApi(message, sender);
  } catch (err) {
    console.error(colors.red(`❌ Ошибка API: ${err.message}`));
    return `${sender}: Я ограничен по лимиту или произошла ошибка`;
  }
}

function parseDDNetAddress(address) {
  const cleanAddress = address.replace(/tw-0\.[6-7]\+udp:\/\//, '');
  
  const ipv6Match = cleanAddress.match(/^\[(.*?)\]:(\d+)$/);
  if (ipv6Match) {
    const host = ipv6Match[1];
    const port = parseInt(ipv6Match[2]);
    if (isNaN(port) || port <= 0 || port >= 65536) return null;
    return { host, port };
  }

  const parts = cleanAddress.split(':');
  if (parts.length === 2) {
    const host = parts[0];
    const port = parseInt(parts[1]);
    if (isNaN(port) || port <= 0 || port >= 65536) return null;
    return { host, port };
  }

  return null;
}

async function broadcastToAllServers(message) {
  console.log(colors.cyan(`📣 Рассылка всем серверам: ${colors.italic(message)}`));
  
  for (const client of clients) {
    try {
      await client.game.Say(message);
      totalMessagesSent++;
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(colors.red(`❌ Не удалось отправить системное сообщение на сервер: ${err.message}`));
    }
  }
}

function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours}ч ${minutes}м ${secs}с`;
}

function displayStats() {
  console.log(colors.cyan('╔════════════════════════════════════════╗'));
  console.log(colors.cyan('║           СТАТИСТИКА БОТА             ║'));
  console.log(colors.cyan('╚════════════════════════════════════════╝'));
  console.log(colors.green('Подключенные серверы: ') + colors.white(clients.filter(c => c.connected).length + '/' + clients.length));
  console.log(colors.green('Всего отправлено сообщений: ') + colors.white(totalMessagesSent));
  console.log(colors.green('Время работы: ') + colors.white(formatUptime(process.uptime())));
  console.log(colors.green('Использование памяти: ') + colors.white((process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' МБ'));
}

async function startBot() {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync('settings.bot', 'utf8'));
  } catch (err) {
    console.error(colors.red(`❌ Ошибка загрузки настроек: ${err.message}`));
    console.log(colors.yellow('⚠️ Создаю файл настроек по умолчанию...'));
    settings = {
      name: "TeeAI",
      clan: "[BOT]",
      reconnectAttempts: 3,
      responseDelay: 3000,
      messageDelay: 500
    };
    fs.writeFileSync('settings.bot', JSON.stringify(settings, null, 2));
  }
  
  let servers;

  console.log(colors.cyan('╔════════════════════════════════════════╗'));
  console.log(colors.cyan('║         TEEWORLDS AI ЧАТ-БОТ          ║'));
  console.log(colors.cyan('╚════════════════════════════════════════╝'));
  console.log(colors.magenta(`Работает на ${os.platform()} | Node.js ${process.version}`));
  console.log(colors.cyan('Доступные команды:'));
  console.log(colors.green('/broadcast [сообщение]') + colors.white(' - Рассылка сообщения всем серверам'));
  console.log(colors.green('/stats') + colors.white(' - Показать статистику бота'));
  console.log(colors.green('/exit') + colors.white(' - Выйти из бота'));
  
  // Загрузка IP адресов из файла
  try {
    console.log(colors.blue('📂 Загрузка IPs из файла ips.bot...'));
    if (!fs.existsSync('ips.bot')) {
      console.log(colors.yellow('⚠️ Файл ips.bot не найден, создаю пример...'));
      fs.writeFileSync('ips.bot', '127.0.0.1:8303\nexample.com:8303');
    }
    
    servers = fs.readFileSync('ips.bot', 'utf8')
      .split('\n')
      .filter(ip => ip.trim())
      .map(ip => {
        const [host, port = '8303'] = ip.split(':');
        const parsedPort = parseInt(port);
        if (isNaN(parsedPort) || parsedPort <= 0 || parsedPort >= 65536) return null;
        return { host, port: parsedPort };
      })
      .filter(result => result !== null);
  } catch (err) {
    console.error(colors.red(`❌ Ошибка загрузки IPs: ${err.message}`));
    process.exit(1);
  }

  if (servers.length === 0) {
    console.error(colors.red('❌ Валидные IPs не найдены. Выход...'));
    process.exit(1);
  }

  console.log(colors.green(`✅ Подключение к ${servers.length} серверам как "${settings.name}"`));
  console.log(colors.magenta('💬 Вводите команды ниже:'));

  clients = [];
  servers.forEach(({ host, port }) => {
    const client = new teeworlds.Client(host, port, settings.name, settings.clan);
    client.serverAddress = `${host}:${port}`;
    clients.push(client);

    client.connect();

    client.on('connected', () => {
      console.log(colors.green(`✅ Подключен к ${colors.bold(`${host}:${port}`)}!`));
      client.game.Say("Привет! Я здесь, чтобы общаться.");
      reconnectAttempts[`${host}:${port}`] = 0;
    });

    client.on('message', async (message) => {
      const sender = message.author?.ClientInfo?.name || 'Неизвестный';
      const msgText = message.message || '';

      const match = msgText.match(/^([^:]+):\s*(.+)$/);
      if (!match) return;

      const targetName = match[1].trim();
      const actualMessage = match[2].trim();

      if (sender === settings.name) return;

      if (message.team === 0 || message.team === 1) {
        const teamType = message.team === 0 ? colors.white('♨️  Все') : colors.yellow('🔒 Команда');
        console.log(`${teamType} ${colors.cyan(`[${host}:${port}]`)} ${colors.magenta(sender)}: ${colors.white(actualMessage)}`);
      }

      if (msgText.toLowerCase().includes('joined') && sender.toLowerCase() === 'strew') {
        await client.game.Say('привет, strew!');
        console.log(colors.green(`👋 Приветствовал strew на ${host}:${port}!`));
        return;
      }

      const reply = await generateResponse(actualMessage, sender);
      if (reply) {
        console.log(colors.blue(`🔄 Готовлю ответ для ${colors.bold(sender)}...`));
        
        await new Promise(resolve => setTimeout(resolve, settings.responseDelay || 3000));
        
        const finalMessage = reply.replace(/(\r\n|\n|\r)/gm, ' ').trim();
        console.log(colors.green(`💬 Отправляю: ${colors.italic(finalMessage)}`));
        await client.game.Say(finalMessage);
        totalMessagesSent++;
      }
    });

    client.on('disconnect', (reason) => {
      console.log(colors.red(`❌ Отключен от ${host}:${port}: ${reason}`));
      const key = `${host}:${port}`;
      reconnectAttempts[key] = (reconnectAttempts[key] || 0) + 1;
      
      if (reconnectAttempts[key] <= settings.reconnectAttempts) {
        console.log(colors.yellow(`🔄 Попытка переподключения (${reconnectAttempts[key]}/${settings.reconnectAttempts})...`));
        setTimeout(() => {
          console.log(colors.blue(`🔄 Переподключение к ${host}:${port}...`));
          client.connect();
        }, 5000 * reconnectAttempts[key]);
      }
    });

    client.on('error', (error) => {
      console.error(colors.red(`❌ Ошибка на ${host}:${port}: ${error.message}`));
    });
  });

  let lastSaveTime = Date.now();
  const LOG_INTERVAL = 300000;
  
  function logActivity() {
    const now = Date.now();
    if (now - lastSaveTime >= LOG_INTERVAL) {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] Подключенные серверы: ${clients.filter(c => c.connected).length}/${clients.length}, Всего сообщений: ${totalMessagesSent}\n`;
      
      fs.appendFileSync('activity.log', logMessage);
      console.log(colors.gray(`📊 Активность записана в файл`));
      
      lastSaveTime = now;
    }
  }
  
  setInterval(logActivity, 60000);

  // Исправленная обработка ввода с консоли
  rl.on('line', async (input) => {
    const trimmedInput = input.trim();
    if (trimmedInput === '') return;
    
    // Обработка команд
    if (trimmedInput.startsWith('/')) {
      const parts = trimmedInput.slice(1).split(' ');
      const command = parts[0].toLowerCase();
      const args = parts.slice(1).join(' ');
      
      switch (command) {
        case 'broadcast':
        case 'bc':
          if (!args) {console.log(colors.yellow('⚠️ Укажите сообщение после /broadcast'));
            break;
          }
          await broadcastToAllServers(args);
          break;
          
        case 'stats':
          displayStats();
          break;
          
        case 'exit':
        case 'quit':
          console.log(colors.yellow('👋 Завершение работы...'));
          try {
            await Promise.all(clients.map(client => {
              if (client.connected) {
                return client.game.Say('До свидания!')
                  .then(() => client.Disconnect());
              }
              return Promise.resolve();
            }));
          } catch (err) {
            console.error(colors.red(`Ошибка при завершении: ${err.message}`));
          }
          console.log(colors.green('✅ Отключен от всех серверов'));
          process.exit(0);
          break;
          
        default:
          console.log(colors.yellow(`⚠️ Неизвестная команда: ${command}`));
          console.log(colors.yellow('Доступны только команды /broadcast, /stats и /exit'));
      }
    } else {
      // Если это не команда, отправляем как сообщение на все серверы
      await broadcastToAllServers(trimmedInput);
    }
  });

  process.on('SIGINT', async () => {
    console.log(colors.yellow('\n👋 Завершение работы...'));
    rl.close();
    
    try {
      await Promise.all(clients.map(client => {
        if (client.connected) {
          return client.game.Say('До свидания!')
            .then(() => client.Disconnect());
        }
        return Promise.resolve();
      }));
    } catch (err) {
      console.error(colors.red(`Ошибка при завершении: ${err.message}`));
    }
    
    console.log(colors.green('✅ Успешно отключен от всех серверов'));
    process.exit(0);
  });
  
  process.on('uncaughtException', (err) => {
    console.error(colors.red(`❌ Необработанное исключение: ${err.message}`));
    console.error(err.stack);
    
    fs.appendFileSync('error.log', `[${new Date().toISOString()}] Необработанное исключение: ${err.message}\n${err.stack}\n\n`);
    console.log(colors.yellow('Ошибка записана в error.log'));
  });
  
  console.log(colors.green('✅ Бот успешно запущен!'));
}

startBot().catch(err => {
  console.error(colors.red(`❌ Ошибка запуска бота: ${err.message}`));
  fs.appendFileSync('error.log', `[${new Date().toISOString()}] Ошибка запуска: ${err.message}\n${err.stack}\n\n`);
  process.exit(1);
});

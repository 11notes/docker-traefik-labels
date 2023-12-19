process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));
const { fork } = require('node:child_process');
const child = fork(`${__dirname}/app.js`, [], {
  env:{
    LABELS_REDIS_URL:process.env?.LABELS_REDIS_URL || 'rediss://localhost:6379/0',
    LABELS_INTERVAL:parseInt(process.env?.LABELS_INTERVAL || 300),
    LABELS_TIMEOUT:parseInt(process.env?.LABELS_TIMEOUT|| 30),
    LABELS_WEBHOOK:process.env?.LABELS_WEBHOOK || '',
    LABELS_WEBHOOK_AUTH_BASIC:process.env?.LABELS_WEBHOOK_AUTH_BASIC || '',
  }
});
child.on('error', (error) =>{
  console.error(error);
});
child.on('close', (code) =>{
  console.warn(`child process closed with exit code ${code}`);
  process.exit(code);
});
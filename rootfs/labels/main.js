process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));

const Docker = require('dockerode');
const redis = require('redis');

const ERROR = 1;
const POLL_INTERVAL = parseInt(process.env?.LABELS_INTERVAL || 300);
const POLL_TIMEOUT = parseInt(process.env?.LABELS_TIMEOUT|| 30);

class Labels{
  #docker;
  #redis;
  #poll = false;
  #webhook = {
    headers:{'Content-Type':'application/json'}
  };

  constructor(){
    this.#docker = new Docker({socketPath:'/run/docker.sock'});
    if('' !== process.env.LABELS_WEBHOOK_AUTH_BASIC){
      this.#webhook.headers['Authorization'] = 'Basic ' + Buffer.from(process.env.LABELS_WEBHOOK_AUTH_BASIC).toString('base64')
    }
  }

  #log(message, type){
    console.log(JSON.stringify({
      time:new Date().toISOString(),
      type:(type === ERROR) ? 'ERROR' : 'INFO',
      message:message,
    }));
  }

  async watch(){
    if('' !== process.env.LABELS_WEBHOOK){
      this.#log(`using webhook ${process.env.LABELS_WEBHOOK}`);
    }

    this.#redis = await redis.createClient({
      url:process.env.LABELS_REDIS_URL,
      pingInterval:30000,
      socket:{
        rejectUnauthorized: false,
      }
    });

    this.#redis.connect();
    this.#redis.on('ready', ()=>{
      this.#log('successfully connected to redis');
      (async() => {
        await this.dockerPoll();
      })();
      this.dockerEvents();
    });

    this.#redis.on('error', error =>{
      this.#log(error, ERROR);
    });

    setInterval(async() => {
      await this.dockerPoll();
    }, POLL_INTERVAL*1000);
  }

  dockerEvents(){
    this.#docker.getEvents({}, (error, data) => {
      if(error){
        this.#log(error, ERROR);
      }else{
        data.on('data', async(chunk) => {
          const event = JSON.parse(chunk.toString('utf8'));
          if(/Container/i.test(event?.Type) && /^(start|kill)$/i.test(event?.status)){
            await this.dockerInspect(event.id, event.status);
          }
        });
      }
    });
  }

  async dockerPoll(){
    if(!this.#poll){
      try{
        this.#poll = true;
        this.#docker.listContainers((error, containers) => {
          if(!error){
            containers.forEach(async(container) => {
              await this.dockerInspect(container.Id, 'poll');
            });
          }
        });
      }catch(e){
        this.#log(e, ERROR);
      }finally{
        this.#poll = false;
      }
    }
  }

  dockerInspect(id, status = null){
    return(new Promise((resolve, reject) => {
      const container = this.#docker.getContainer(id);
      container.inspect(async(error, data) => {
        if(!error){
          const update = (/start|poll/i.test(status)) ? true : false;
          const webHook = {event:status, labels:{}};

          this.#log(`inspect container {${(data?.Name || data?.id).replace(/^\//i, '')}}${(
            (null === status) ? '' : ` event[${status}]`
          )}`);
      
          for(const label in data?.Config?.Labels){
            if(/traefik\//i.test(label)){
              if('' !== process.env.LABELS_WEBHOOK){
                webHook.labels[label] = data?.Config?.Labels[label];
              }
              if(update){
                await this.#redis.set(label, data?.Config?.Labels[label], {EX:POLL_INTERVAL + POLL_TIMEOUT});
              }else{
                await this.#redis.del(label);
              }
            }
          }

          if('' !== process.env.LABELS_WEBHOOK){           
            try{
              await fetch(process.env.LABELS_WEBHOOK, {method:(
                (update) ? 'PUT' : 'DELETE'
              ), body:JSON.stringify(webHook), headers:this.#webhook.headers, signal:AbortSignal.timeout(2500)});
            }catch(e){
              this.#log(e, ERROR);
            }
          }

          resolve(true);
        }
      });
    }));
  }
}

new Labels().watch();
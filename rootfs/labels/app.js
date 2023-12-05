const Docker = require('dockerode');
const redis = require('redis');
const ERROR = 1;

class Labels{
  #docker;
  #redis;
  #poll = false;

  constructor(){
    this.#docker = new Docker({socketPath:'/run/docker.sock'});
  }

  #log(message, error){
    console.log(JSON.stringify({
      time:new Date().toISOString(),
      type:(error === ERROR) ? 'ERROR' : 'INFO',
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
      this.#log('successfully connected to redis database');
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
    }, parseInt(process.env.LABELS_INTERVAL)*1000);
  }

  dockerEvents(){
    this.#docker.getEvents({}, (error, data) => {
      if(error){
        this.#log(error, ERROR);
      }else{
        data.on('data', async(chunk) => {
          const event = JSON.parse(chunk.toString('utf8'));
          if(/Container/i.test(event?.Type) && /^(start|stop|restart|kill|die|destroy)$/i.test(event?.status)){
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
        this.#log(`poll start (interval:${process.env.LABELS_INTERVAL})}`);
        this.#docker.listContainers((error, containers) => {
          containers.forEach(async(container) => {
            await this.dockerInspect(container.Id);
          });
        });
      }catch(e){
        this.#log(e, ERROR);
      }finally{
        this.#log('poll end');
        this.#poll = false;
      }
    }
  }

  dockerInspect(id, status = null){
    return(new Promise((resolve, reject) => {
      const container = this.#docker.getContainer(id);
      container.inspect(async(error, data) => {

        let update = false;
        const webHook = {event:status, labels:{}}; 
        const headers = {'Content-Type':'application/json'};

        if('' !== process.env.LABELS_WEBHOOK_AUTH_BASIC){
          headers['Authorization'] = 'Basic ' + Buffer.from(process.env.LABELS_WEBHOOK_AUTH_BASIC).toString('base64')
        }

        if(error){
          reject(error);
        }

        this.#log(`inspect container ${data.Name.replace(/^\//i, '')}${(
          (null === status) ? '' : ` event[${status}]`
        )}`);

        if(/start|restart/i.test(status)){
          update = true;
        }
     
        for(const label in data?.Config?.Labels){
          if(/traefik\//i.test(label)){
            webHook.labels[label] = data?.Config?.Labels[label];
            if(update){
              await this.#redis.set(label, data?.Config?.Labels[label], {EX:parseInt(process.env.LABELS_INTERVAL) + parseInt(process.env.LABELS_TIMEOUT)});
            }else{
              await this.#redis.del(label);
            }
          }
        }
        if('' !== process.env.LABELS_WEBHOOK){
          try{
            const webHookCall = await fetch(process.env.LABELS_WEBHOOK, {method:(
              (update) ? 'PUT' : 'DELETE'
            ), body:JSON.stringify(webHook), headers:headers});
          }catch(e){
            this.#log(e, ERROR);
          }
        }
        resolve(true);
      });
    }));
  }
}

new Labels().watch();
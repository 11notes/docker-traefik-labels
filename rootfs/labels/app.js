const Docker = require('dockerode');
const redis = require('redis');
const ERROR = 1;

class Labels{
  #docker;
  #redis;
  #poll = false;

  constructor(){
    this.#docker = new Docker({socketPath: '/run/docker.sock'});
  }

  #log(message, error){
    console.log(JSON.stringify({
      time:new Date().toISOString(),
      type:(error === ERROR) ? 'ERROR' : 'INFO',
      message:message,
    }));
  }

  async watch(){
    this.#redis = await redis.createClient({
      url:process.env.LABELS_REDIS_URL,
      pingInterval:30000,
      socket:{
        rejectUnauthorized: false,
      }
    });

    this.#redis.connect();
    this.#redis.on('ready', ()=>{
      this.#log('connected to Redis');
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
          if(/Container/i.test(event?.Type) && /start|stop|restart|kill|die|destroy/i.test(event?.status)){
            this.#log(`new docker event [${event?.Type}] for container ${event.id}`);
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
            await this.dockerInspect(container.Id, 'start');
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
        if(error){
          reject(error);
        }
        for(const label in data?.Config?.Labels){
          if(/traefik\//i.test(label)){
            switch(true){
              case /start|restart/i.test(status):
                await this.#redis.set(label, data?.Config?.Labels[label], {EX:parseInt(process.env.LABELS_INTERVAL) + parseInt(process.env.LABELS_TIMEOUT)});
              break;

              case /stop|kill|die|destroy/i.test(status):
                await this.#redis.del(label);
              break;
            }
          }
        }
        resolve(true);
      });
    }));
  }
}

new Labels().watch();
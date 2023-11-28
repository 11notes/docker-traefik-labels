const Docker = require('dockerode');
const redis = require('redis');

class Labels{
  #docker;
  #redis;

  constructor(){
    this.#docker = new Docker({socketPath: '/run/docker.sock'});
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
      this.dockerEvents();
    });

    this.#redis.on('error', error =>{
      console.error(error);
    });

    setInterval(() => {
      this.dockerPoll();
    }, parseInt(process.env.LABELS_INTERVAL)*1000);
  }

  dockerEvents(){
    this.#docker.getEvents({}, (error, data) => {
      data.on('data', (chunk) => {
        const event = JSON.parse(chunk.toString('utf8'));
        if(/Container/i.test(event?.Type) && /start|stop|restart|kill|die|destroy/i.test(event?.status)){
          this.dockerInspect(event.id, event.status);
        }
      });
    });
  }

  dockerPoll(){
    this.#docker.listContainers((error, containers) => {
      containers.forEach(container => {
        this.dockerInspect(container.Id, 'start');
      });
    });
  }

  dockerInspect(id, status = null){
    const container = this.#docker.getContainer(id);
    container.inspect(async(error, data) => {
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
    });
  }
}

new Labels().watch();
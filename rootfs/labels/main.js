process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));

const Docker = require('dockerode');
const redis = require('redis');
const { nsupdate } = requore('./nsupdate');
const { logJSON } = require('/labels/lib/util.js');

const ENV_REDIS_INTERVAL = parseInt(process.env?.LABELS_INTERVAL || 300);
const ENV_REDIS_TIMEOUT = parseInt(process.env?.LABELS_TIMEOUT|| 30);
const ENV_LABELS_WEBHOOK = process.env?.LABELS_WEBHOOK;
const ENV_LABELS_WEBHOOK_AUTH_BASIC = process.env?.LABELS_WEBHOOK_AUTH_BASIC;

class Labels{
  #docker;
  #redis;
  #poll = false;
  #webhook = {
    headers:{'Content-Type':'application/json'}
  };

  constructor(){
    this.#docker = new Docker({socketPath:'/run/docker.sock'});
    if(ENV_LABELS_WEBHOOK_AUTH_BASIC){
      this.#webhook.headers['Authorization'] = 'Basic ' + Buffer.from(ENV_LABELS_WEBHOOK_AUTH_BASIC).toString('base64')
    }
  }

  async watch(){
    if(ENV_LABELS_WEBHOOK){
      logJSON('info', `using webhook ${ENV_LABELS_WEBHOOK}`);
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
      logJSON('info', 'successfully connected to redis');
      (async() => {
        await this.dockerPoll();
      })();
      this.dockerEvents();
    });

    this.#redis.on('error', error =>{
      logJSON('error', error);
    });

    setInterval(async() => {
      await this.dockerPoll();
    }, ENV_REDIS_INTERVAL*1000);
  }

  dockerEvents(){
    this.#docker.getEvents({}, (error, data) => {
      if(error){
        logJSON('error', error);
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
        logJSON('error', e);
      }finally{
        this.#poll = false;
      }
    }
  }

  async dockerInspect(id, status = null){
    return(new Promise((resolve, reject) => {
      const container = this.#docker.getContainer(id);
      container.inspect(async(error, data) => {
        if(!error){
          const update = (/start|poll/i.test(status)) ? true : false;
          const container = {
            event:status,
            labels:{
              traefik:[],
              rfc2136:[],
            },
          };

          const rfc2136 = {
            WAN:{server:'', key:'', commands:[]},
            LAN:{server:'', key:'', commands:[]},
          }
      
          for(const label in data?.Config?.Labels){
            switch(true){
              case /traefik\//i.test(label):
                if(update){
                  await this.#redis.set(label, data?.Config?.Labels[label], {EX:ENV_REDIS_INTERVAL + ENV_REDIS_TIMEOUT});
                }else{
                  await this.#redis.del(label);
                }
                container.labels.traefik[label] = data?.Config?.Labels[label];
              break;

              case /rfc2136\//i.test(label):
                container.labels.rfc2136[label] = data?.Config?.Labels[label];
                const type = ((label.match(/rfc2136\/WAN\//i)) ? 'WAN' : 'LAN');
                switch(true){
                  case /rfc2136\/\S+\/server/i.test(label):
                    rfc2136[type].server = data?.Config?.Labels[label];
                  break;

                  case /rfc2136\/\S+\/key/i.test(label):
                    rfc2136[type].key = data?.Config?.Labels[label];
                  break;

                  default:
                    if(!update){
                      data?.Config?.Labels[label] = data?.Config?.Labels[label].replace(/update add/i, 'update delete');
                    }
                    rfc2136[type].commands.push(data?.Config?.Labels[label]);
                }
              break;
            }
          }

          for(const type in rfc2136){
            if(rfc2136[type].commands.length > 0 && rfc2136[type].server && rfc2136[type].key){
              try{
                await nsupdate(rfc2136[type].server, rfc2136[type].key, rfc2136[type].commands);
              }catch(e){
                logJSON('error', e);
              }
            }
          }

          if(ENV_LABELS_WEBHOOK){           
            try{
              await fetch(ENV_LABELS_WEBHOOK, {method:(
                (update) ? 'PUT' : 'DELETE'
              ), body:JSON.stringify(container), headers:this.#webhook.headers, signal:AbortSignal.timeout(2500)});
            }catch(e){
              logJSON('error', e);
            }
          }

          resolve(true);
        }
      });
    }));
  }
}

new Labels().watch();
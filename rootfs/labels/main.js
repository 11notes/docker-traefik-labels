process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));

const Docker = require('dockerode');
const redis = require('redis');
const { nsupdate } = require('./nsupdate');
const { dig } = require('./dig');
const { elevenLogJSON } = require('/labels/lib/util.js');

const ENV_REDIS_INTERVAL = parseInt(process.env?.LABELS_INTERVAL || 300);
const ENV_REDIS_TIMEOUT = parseInt(process.env?.LABELS_TIMEOUT|| 30);
const ENV_LABELS_WEBHOOK = process.env?.LABELS_WEBHOOK;
const ENV_LABELS_WEBHOOK_AUTH_BASIC = process.env?.LABELS_WEBHOOK_AUTH_BASIC;
const ENV_LABELS_RFC2136_ONLY_UPDATE_ON_CHANGE = process.env?.LABELS_RFC2136_ONLY_UPDATE_ON_CHANGE || false;

elevenLogJSON('info', {config:{
  LABELS_INTERVAL :ENV_REDIS_INTERVAL,
  LABELS_TIMEOUT:ENV_REDIS_TIMEOUT,
  LABELS_WEBHOOK:ENV_LABELS_WEBHOOK,
  LABELS_WEBHOOK_AUTH_BASIC:((ENV_LABELS_WEBHOOK_AUTH_BASIC) ? true: false)
}});

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
    this.#redis = await redis.createClient({
      url:process.env.LABELS_REDIS_URL,
      pingInterval:30000,
      socket:{
        rejectUnauthorized: false,
      }
    });

    this.#redis.connect();
    this.#redis.on('ready', ()=>{
      (async() => {
        await this.dockerPoll();
      })();
      this.dockerEvents();
    });

    this.#redis.on('error', error =>{
      elevenLogJSON('error', error);
    });

    setInterval(async() => {
      await this.dockerPoll();
    }, ENV_REDIS_INTERVAL*1000);
  }

  dockerEvents(){
    this.#docker.getEvents({}, (error, data) => {
      if(error){
        elevenLogJSON('error', error);
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
        elevenLogJSON('error', e);
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
            name:(data?.Name || data?.id).replace(/^\//i, ''),
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

          elevenLogJSON('info', `container {${container.name}}.inspect()${(
            (null === status) ? '' : ` event[${status}]`
          )}`);
      
          for(const label in data?.Config?.Labels){
            switch(true){
              case /traefik\//i.test(label):
                if(update){
                  await this.#redis.set(label, data.Config.Labels[label], {EX:ENV_REDIS_INTERVAL + ENV_REDIS_TIMEOUT});
                }else{
                  await this.#redis.del(label);
                }
                container.labels.traefik[label] = data.Config.Labels[label];
              break;

              case /rfc2136\//i.test(label):
                container.labels.rfc2136[label] = data.Config.Labels[label];
                const type = ((label.match(/rfc2136\/WAN\//i)) ? 'WAN' : 'LAN');
                switch(true){
                  case /rfc2136\/\S+\/server/i.test(label):
                    rfc2136[type].server = data.Config.Labels[label];
                  break;

                  case /rfc2136\/\S+\/key/i.test(label):
                    rfc2136[type].key = data.Config.Labels[label];
                  break;

                  default:
                    if(!update){
                      data.Config.Labels[label] = data.Config.Labels[label].replace(/update add/i, 'update delete');
                    }
                    if((ENV_LABELS_RFC2136_ONLY_UPDATE_ON_CHANGE && !await this.rfc2136KnownRecord(rfc2136[type].server, data.Config.Labels[label])) || true){                      
                      rfc2136[type].commands.push(data.Config.Labels[label]);
                    }
                }
              break;
            }
          }

          for(const type in rfc2136){
            if(rfc2136[type].commands.length > 0 && rfc2136[type].server && rfc2136[type].key){
              try{
                elevenLogJSON('info', `container {${container.name}}.rfc2136() update ${type} DNS entries`);
                await nsupdate(rfc2136[type].server, rfc2136[type].key, rfc2136[type].commands);
              }catch(e){
                elevenLogJSON('error', e);
              }
            }
          }

          if(ENV_LABELS_WEBHOOK){           
            try{
              await fetch(ENV_LABELS_WEBHOOK, {method:(
                (update) ? 'PUT' : 'DELETE'
              ), body:JSON.stringify(container), headers:this.#webhook.headers, signal:AbortSignal.timeout(2500)});
            }catch(e){
              elevenLogJSON('error', e);
            }
          }

          resolve(true);
        }
      });
    }));
  }

  async rfc2136KnownRecord(server, nsupdate){
    const matches = nsupdate.match(/update add (\S+) \d+ (\S+) (\S+)/i);
    if(matches && matches.length >= 4){
      try{
        const record = await dig(server, matches[2], matches[1]);
        return(matches[1].match(new RegExp(record, 'ig')));
      }catch(e){
        elevenLogJSON('error', e);
        return(false);
      }
    }    
  }
}

new Labels().watch();
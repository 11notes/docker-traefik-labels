const fs = require('fs');
const Docker = require('dockerode');
const yaml = require('js-yaml');
const redis = require('redis');
const { nsupdate } = require('./nsupdate');
const { dig } = require('./dig');
const { elevenLogJSON } = require('/labels/lib/util.js');

process
  .on('unhandledRejection', (e, p) => {
    elevenLogJSON('error', JSON.stringify({rejection:{exception:e.toString()}}));
  })
  .on('uncaughtException', e => {
    elevenLogJSON('error', JSON.stringify({exception:{exception:e.toString()}}));
  });

class Labels{
  #config = yaml.load(fs.readFileSync(`${process.env.APP_ROOT}/etc/config.yaml`, 'utf8'))?.labels;
  #defaults = {
      tls:{
        ca:`${process.env.APP_ROOT}/ssl/ca.crt`,
        crt:`${process.env.APP_ROOT}/ssl/labels.crt`,
        key:`${process.env.APP_ROOT}/ssl/labels.key`,
        port:2376
      },poll:{interval:300}, ping:{interval:2.5}, redis:{url:'rediss://localhost:6379/0'}, rfc2136:{'update-only':false}};
  #intervals = {ping:false, poll:false};
  #loops = {ping:false, poll:false};
  #redis;
  #nodes = {};

  constructor(){
    for(const node of this.#config?.nodes){
      this.#nodes[node] = new Docker({
        protocol:'https',
        host:node,
        port:this.#config?.tls?.port || this.#defaults.tls.port,
        ca:fs.readFileSync(this.#config?.tls?.ca || this.#defaults.tls.ca),
        cert:fs.readFileSync(this.#config?.tls?.crt || this.#defaults.tls.crt),
        key:fs.readFileSync(this.#config?.tls?.key || this.#defaults.tls.key),
      });
      this.#nodes[node].labels = {ping:false, firstConnect:true};
    }

    if(this.#config?.webhook?.url){
      this.#config.webhook.headers = {'Content-Type':'application/json'};
      switch(true){
        case this.#config?.webhook?.auth?.basic:
          this.#config.webhook.headers['Authorization'] = 'Basic ' + Buffer.from(this.#config.webhook.auth.basic).toString('base64');
          break;
      }      
    }
  }

  async watch(){  
    this.#redis = await redis.createClient({
      url:this.#config?.redis?.url || this.#defaults.redis.url,
      pingInterval:30000,
      socket:{
        rejectUnauthorized:false,
      },
      disableOfflineQueue:false,
      commandsQueueMaxLength:1024
    });

    this.#redis.on('ready', async()=>{
      elevenLogJSON('info', `connected to redis`);
      await this.#ping();
      await this.#poll();
    });

    this.#redis.on('error', error =>{
      elevenLogJSON('error', JSON.stringify({redis:{exception:error.toString()}}));
    });

    this.#redis.connect();
  }

  async #ping(){
    if(!this.#intervals.ping){
      this.#intervals.ping = true;
      setInterval(async() => {
        if(!this.#loops.ping){
          this.#loops.ping = true;
          try{
            await this.#ping()
          }catch(e){
            elevenLogJSON('error', JSON.stringify({ping:{exception:e.toString()}}));
          }finally{
            this.#loops.ping = false;
          }
        }
      }, (this.#config?.ping?.interval || this.#defaults.ping.interval)*1000);
      await this.#ping();
    }

    for(const node in this.#nodes){
      try{
        await this.#nodes[node].ping();
        if(!this.#nodes[node].labels.ping){
          elevenLogJSON('info', `connected to node [${node}]`);
          this.#nodes[node].getEvents({}, (error, data) => {
            if(!error){
              data.on('data', async(chunk) =>{
                const event = JSON.parse(chunk.toString('utf8'));
                if(/Container/i.test(event?.Type) && /^(start|die)$/i.test(event?.status)){
                  await this.#inspect(node, event.id, event.status);
                }
              });
            }else{
              elevenLogJSON('error', JSON.stringify({getEvents:{exception:error.toString()}}));
            }
          });
        }
        this.#nodes[node].labels.ping = true;
      }catch(e){
        elevenLogJSON('error', JSON.stringify({ping:{exception:e.toString()}}));
        if(this.#nodes[node].labels.ping && !this.#nodes[node].labels.firstConnect){
          elevenLogJSON('warning', `connection to node [${node}] lost!`);
        }else if(this.#nodes[node].labels.firstConnect){
          this.#nodes[node].labels.firstConnect = false;
          elevenLogJSON('warning', `connection to node [${node}] failed!`);
        }
        this.#nodes[node].labels.ping = false;
      }
    }
  }

  async #poll(){
    if(!this.#intervals.poll){
      this.#intervals.poll = true;
      setInterval(async() => {
        if(!this.#loops.poll){
          this.#loops.poll = true;
          try{
            await this.#poll()
          }catch(e){
            elevenLogJSON('error', JSON.stringify({poll:{exception:e.toString()}}));
          }finally{
            this.#loops.poll = false;
          }
        }
      }, (this.#config?.poll?.interval || this.#defaults.poll.interval)*1000);
      await this.#poll();
    }

    for(const node in this.#nodes){
      try{
        await this.#nodes[node].listContainers((error, containers) => {
          if(!error){
            containers.forEach(async(container) => {
              await this.#inspect(node, container.Id, 'poll');
            });
          }
        });
      }catch(e){
        elevenLogJSON('error', JSON.stringify({listContainers:{exception:e.toString()}}));
      }
    }
  }

  async #inspect(node, id, event){
    return(new Promise((resolve, reject) => {
      const container = this.#nodes[node].getContainer(id);
      container.inspect(async(error, data) => {
        if(!error){
          const container = {
            name:(data?.Name || data?.id).replace(/^\//i, ''),
            event:event,
            run:(/start|poll/i.test(event)) ? true : false,
            labels:{
              traefik:[],
              rfc2136:[],
            },
          };

          elevenLogJSON('info', `[${node}] container [${container.name}] event [${container.event}]`);

          const rfc2136 = {
            WAN:{server:'', key:'', commands:[]},
            LAN:{server:'', key:'', commands:[]},
          }
          
          for(const label in data?.Config?.Labels){
            switch(true){
              case /traefik\//i.test(label):
                if(container.run){
                  await this.#redis.set(label, data.Config.Labels[label], {EX:(this.#config?.poll?.interval || this.#defaults.poll.interval) + 30});
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
                    if(!container.run){
                      data.Config.Labels[label] = data.Config.Labels[label].replace(/update add/i, 'update delete');
                    }
                    rfc2136[type].commands.push(data.Config.Labels[label]);
                }
              break;
            }
          }

          if(rfc2136.LAN.commands.length > 0 || rfc2136.WAN.commands.length){
            await this.#rfc2136(rfc2136);
          }

          if(this.#config?.webhook?.url){
            await this.#webhook(container);
          }
        }
      })
      resolve(true);
    }));
  }

  async #rfc2136(rfc2136){
    for(const type in rfc2136){
      if(rfc2136[type].commands.length > 0 && rfc2136[type].server && rfc2136[type].key){
        if(this.#config?.rfc2136?.['update-only'] || this.#defaults?.rfc2136?.['update-only']){
          for(let i=0; i<rfc2136[type].commands.length; i++){
            if(await this.#rfc2136knownRecord(rfc2136[type].server, rfc2136[type].commands[i])){
              rfc2136[type].commands.splice(i, 1);
            }
          }
        }
        try{
          if(rfc2136[type].commands.length > 0){
            await nsupdate(rfc2136[type].server, rfc2136[type].key, rfc2136[type].commands);
          }
        }catch(e){
          elevenLogJSON('error', JSON.stringify({nsupdate:{exception:e.toString()}}));
        }
      }
    }
  }

  async #rfc2136knownRecord(server, nsupdate){
    const matches = nsupdate.match(/update add (\S+) \d+ (\S+) (\S+)/i);
    if(matches && matches.length >= 4){
      try{
        const record = await dig(server, matches[2], matches[1]);
        return((record.match(new RegExp(matches[3], 'ig'))));
      }catch(e){
        return(false);
      }
    }    
  }

  async #webhook(container){
    try{
      await fetch(this.#config.webhook.url, {method:(
        (container.run) ? 'PUT' : 'DELETE'
      ), body:JSON.stringify(container), headers:this.#config.webhook.headers, signal:AbortSignal.timeout(2500)});
    }catch(e){
      elevenLogJSON('error', JSON.stringify({webhook:{exception:e.toString()}}));
    }
  }
}

new Labels().watch();
const { fork } = require('node:child_process');
const fs = require('fs');
const yaml = require('js-yaml');
const redis = require('redis');
const { nsupdate } = require('./nsupdate');
const { dig } = require('./dig');
const { elevenLogJSON } = require('/labels/lib/util.js');

process
  .on('unhandledRejection', (e, p) => {
    elevenLogJSON('error', {unhandledRejection:e.toString()});
  })
  .on('uncaughtException', e => {
    elevenLogJSON('error', {uncaughtException:e.toString()});
  });


class Labels{
  #config = {webhook:{headers:{'Content-Type':'application/json'}}};
  #workers = {};
  #interval = {run:false, fok:false};
  #redis;

  constructor(){
    const config = yaml.load(fs.readFileSync(`${process.env.APP_ROOT}/etc/config.yaml`, 'utf8'))?.labels;
    this.#config.redis = {url:(config?.redis?.url || 'rediss://localhost:6379/0')};
    this.#config.webhook.url = (config?.webhook?.url || null);
    if(this.#config.webhook.url && config?.webhook?.auth?.basic){
      this.#config.webhook.headers['Authorization'] = 'Basic ' + Buffer.from(config.webhook.auth.basic).toString('base64');
      elevenLogJSON('info', `using webhook ${this.#config.webhook.url} with basic authentication`);
    }
    this.#config.rfc2136 = {verify:(config?.rfc2136?.verify || false)};
    this.#config.poll = {interval:(config?.poll?.interval || 300)};
    this.#config.ping = {interval:(config?.ping?.interval || 2.5)};
    this.#config.port = (config?.port || 2376);
    this.#config.timeout = (config?.timeout || 5);
    this.#config.interval = (config?.interval || 0);
    this.#config.tls = {
      ca:(config?.tls?.ca || `${process.env.APP_ROOT}/ssl/ca.crt`),
      crt:(config?.tls?.crt || `${process.env.APP_ROOT}/ssl/labels.crt`),
      key:(config?.tls?.key || `${process.env.APP_ROOT}/ssl/labels.key`),
    };

    if(this.#config.interval > 0){
      elevenLogJSON('info', `${process.env.APP_ROOT}/etc/config.yaml will reload labels.nodes every ${this.#config.interval}s`);
    }
  }

  async run(){
    this.#redis = await redis.createClient({
      url:this.#config.redis.url,
      pingInterval:30000,
      socket:{
        rejectUnauthorized:false,
      },
      disableOfflineQueue:false,
      commandsQueueMaxLength:1024
    });

    this.#redis.on('ready', async()=>{
      elevenLogJSON('info', `connected to redis`);

      this.#run();

      if(this.#config.interval > 0){
        setInterval(async ()=>{
          if(!this.#interval.run){
            this.#interval.run = true;
            try{
              await this.#run();
            }catch(e){
              elevenLogJSON('error', {error:e});
            }finally{
              this.#interval.run = false;
            }
          }
        }, this.#config.interval*1000);
      }
  
      setInterval(async()=>{
        if(!this.#interval.fork){
          this.#interval.fork = true;
          try{
            await this.#fork();
          }catch(e){
            elevenLogJSON('error', {error:e});
          }finally{
            this.#interval.fork = false;
          }
        }
      }, this.#config.ping.interval*1000);
    });

    this.#redis.on('error', error =>{
      elevenLogJSON('error', {redis:error.toString()});
    });

    this.#redis.connect();
  }

  #run(){
    const nodes = yaml.load(fs.readFileSync(`${process.env.APP_ROOT}/etc/config.yaml`, 'utf8'))?.labels?.nodes;
    for(const node of nodes){
      if(!this.#workers[node]){
        this.#workers[node] = new Worker(this.#config, node, this);
        this.#workers[node].fork();
        elevenLogJSON('info', `created new worker for node [${node}]`);
      }
    }
  }

  async #fork(){
    for(const node in this.#workers){
      if(!this.#workers[node].run){
        await this.#workers[node].fork();
        if(!this.#workers[node].log.disconnect){
          this.#workers[node].log.disconnect = true;
          elevenLogJSON('info', `trying to fork existing worker for node [${node}] after disconnect`);
        }
      }
    }
  }

  async inspect(container){
    try{
      const counter = {
        add:0,
        del:0,
      };
      const rfc2136 = {
        WAN:{server:'', key:'', commands:[]},
        LAN:{server:'', key:'', commands:[]},
      }
      
      for(const label in container.labels){
        switch(true){
          case /traefik\//i.test(label):
            if(container.start){
              counter.add++;
              await this.#redis.set(label, container.labels[label], {EX:this.#config.poll.interval + 30});
            }else{
              counter.del++;
              await this.#redis.del(label);
            }
          break;

          case /rfc2136\//i.test(label):
            const type = ((label.match(/rfc2136\/WAN\//i)) ? 'WAN' : 'LAN');
            switch(true){
              case /rfc2136\/\S+\/server/i.test(label):
                rfc2136[type].server = container.labels[label];
              break;

              case /rfc2136\/\S+\/key/i.test(label):
                rfc2136[type].key = container.labels[label];
              break;

              default:
                if(!container.start){
                  container.labels[label] = container.labels[label].replace(/update add/i, 'update delete');
                }
                rfc2136[type].commands.push(container.labels[label]);
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

      elevenLogJSON('info', `[${container.worker.node}] container [${container.name}] event [${container.event}]; Traefik: add ${counter.add} / del ${counter.del}; rfc2136: WAN ${rfc2136.WAN.commands.length} / LAN ${rfc2136.LAN.commands.length}`);

    }catch(e){
      elevenLogJSON('error', {inspect:e.toString(), exception:e});
    }
  }

  async #rfc2136(rfc2136){
    for(const type in rfc2136){
      if(rfc2136[type].commands.length > 0 && rfc2136[type].server && rfc2136[type].key){
        if(this.#config.rfc2136.verify){
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
          elevenLogJSON('error', {nsupdate:{exception:e.toString()}});
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
        (container.start) ? 'PUT' : 'DELETE'
      ), body:JSON.stringify(container), headers:this.#config.webhook.headers, signal:AbortSignal.timeout(2500)});
    }catch(e){
      elevenLogJSON('error', {webhook:{exception:e.toString()}});
    }
  }
}

class Worker{
  run = false;
  #fork;
  #config;
  #parent;
  log = {
    disconnect:false,
  }

  constructor(config, node, parent){
    this.#config = {
      tls:config.tls,
      poll:config.poll.interval,
      ping:config.ping.interval,
      port:config.port,
      node:node,
    };
    this.#parent = parent;
  }

  async fork(){
    return(new Promise((resolve, reject) => {
      this.#fork = fork(`${process.env.APP_ROOT}/worker.js`, [JSON.stringify(this.#config)], {stdio: 'inherit'});
      this.#fork.on('spawn', () =>{
        this.run = true;
        resolve();
      });
      this.#fork.on('error', () =>{
        this.run = false;
        reject();
      });
      this.#fork.on('close', (code) =>{
        this.run = false;
      });
      this.#fork.on('message', (message) =>{
        if(message.error){
          if(!this.log.disconnect){
            elevenLogJSON('error', {fork:message.error});
          }
        }else{
          this.run = true;
          this.log.disconnect = false;
          if(message?.labels){
            this.#parent.inspect.apply(this.#parent, [message]);
          }
        }
      });
    }));
  }
}

new Labels().run();
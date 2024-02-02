const fs = require('fs');
const Docker = require('dockerode');
const args = process.argv.slice(2);

process
  .on('unhandledRejection', (e, p) => {
    console.error(e, p);
    process.send({error:e.toString()});
  })
  .on('uncaughtException', e => {
    console.error(e);
    process.send({error:e.toString()});
  });

class Worker{
  #config;
  #docker;
  #interval = {poll:false, ping:false};

  constructor(config){
    this.#config = config;
    this.#docker = new Docker({
      protocol:'https',
      host:this.#config.node,
      port:this.#config.port,
      ca:fs.readFileSync(this.#config.tls.ca),
      cert:fs.readFileSync(this.#config.tls.crt),
      key:fs.readFileSync(this.#config.tls.key),
      timeout:parseInt(this.#config.timeout*1000)
    });
  }

  async run(){
    try{
      this.#docker.getEvents({}, (error, data) => {
        if(!error){
          data.on('data', async(chunk) =>{
            const response = chunk.toString('utf8').replace(',"ti"', '');
            try{
              const event = JSON.parse(response);
              if(/Container/i.test(event?.Type) && /^(start|die)$/i.test(event?.status)){
                this.#labels(event.id, event.status);
              }
            }catch(e){
              //JSON parse error
            }
          });
        }else{
          process.send({error:error.toString()});
        }
      });

      setInterval(async()=>{
        if(!this.#interval.poll){
          this.#interval.poll = true;
          try{
            await this.#poll();
          }catch(e){
            process.send({error:e.toString()});
          }finally{
            this.#interval.poll = false;
          }
        }
      }, this.#config.poll*1000);

      setInterval(async()=>{
        if(!this.#interval.ping){
          this.#interval.ping = true;
          try{
            await this.#ping();
          }catch(e){
            process.send({error:e.toString()});
          }finally{
            this.#interval.ping = false;
          }
        }
      }, this.#config.ping*1000);

      await this.#ping();
      await this.#poll();

    }catch(e){
      process.send({error:e.toString()});
    }
  }

  async #poll(){
    try{
      await this.#docker.listContainers((error, containers) => {
        if(!error){
          containers.forEach(async(container) => {
            this.#labels(container.Id, 'poll');
          });
        }else{
          process.send({error:e.toString()});
        }
      });
    }catch(e){
      process.send({error:e.toString()});
    }
  }

  async #ping(){
    try{
      await this.#docker.ping();
    }catch(e){
      process.exit(1);
    }
  }

  async #labels(id, event){
    try{
      const container = this.#docker.getContainer(id);
      container.inspect(async(error, data) => {
        if(!error){
          const result = {
            name:(data?.Name || data?.id).replace(/^\//i, ''),
            event:event,
            labels:{},
            start:(/start|poll/i.test(event)) ? true : false,
            worker:this.#config.node,
          };
          for(const label in data?.Config?.Labels){
            if(/traefik\/|rfc2136\//i.test(label)){
              result.labels[label] = data.Config.Labels[label];
            }
          }
          process.send(result);
        }else{
          throw(error);
        }
      });
    }catch(e){
      process.send({error:e.toString()});
    }
  }
}

if(Array.isArray(args) && args.length > 0){
  try{
    new Worker(JSON.parse(args)).run();
  }catch(e){
    process.send({error:e.toString()});
    process.exit(1);
  }
}
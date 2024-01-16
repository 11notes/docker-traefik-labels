const { spawn } = require('node:child_process');

exports.nsupdate = async(server, key, commands) => {
  commands.unshift(`server ${server}`);
  commands.push('send');
  return(new Promise((resolve, reject) => {
    const nsupdate = spawn('/usr/bin/nsupdate', ['-y', key]);
    let errors = '';
    nsupdate.stderr.on('data', data  =>{errors += data.toString()});
    nsupdate.on('error', error => {reject(error)});
    nsupdate.on('exit', code =>{
      if(code === 0){
        if(errors.length > 0){
          reject(errors);
        }else{
          resolve(true);
        }
      }else{
        reject(errors);
      }
    });
    for(const command of commands){
      nsupdate.stdin.write(`${command}\n`);
    }
    nsupdate.stdin.end();
  }));
}
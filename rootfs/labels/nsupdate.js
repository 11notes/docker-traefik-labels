const { spawn } = require('node:child_process');

exports.nsupdate = async(server, key, commands) => {

  commands.unshift(`server ${server}`);
  commands.push('send');
  commands.push('quit');

  return(new Promise((resolve, reject) => {
    const nsupdate = spawn('/usr/bin/nsupdate', ['-y', key]);
    const io = {stdout:'', stderr:''};
    nsupdate.stderr.on('data', data => {io.stderr += data.toString()});
    nsupdate.stdout.on('data', data => {io.stdout += (data.toString()).replace(/[\r\n]*$/ig, '')});
    nsupdate.on('error', error => {reject(error)});
    nsupdate.on('close', code =>{
      if(code === 0){
        if(io.stderr.length > 0){
          reject(io.stderr);
        }else{
          resolve(io.stdout);
        }
      }else{
        reject(io.stderr);
      }
    });
    for(const command of commands){
      nsupdate.stdin.write(`${command}\n`);
    }
    nsupdate.stdin.end();
  }));
}
const { spawn } = require('node:child_process');

exports.dig = async(resolver, type, record) => {
  return(new Promise((resolve, reject) => {
    const dig = spawn('/usr/bin/dig', ['+short', '+answer', type, record, `@${resolver}`]);
    const io = {stdout:'', stderr:''};
    dig.stderr.on('data', data => {io.stderr += data.toString()});
    dig.stdout.on('data', data => {io.stdout += (data.toString()).replace(/[\r\n]*$/ig, '')});
    dig.on('error', error => {reject(error)});
    dig.on('close', code =>{
      switch(true){
        case /no servers could be reached/ig.test(io.stdout): io.stderr += io.stdout; break;
      }
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
  }));
}
const path = require('path');
const fs = require('fs');

// Try to find the built node module
const modulePath = path.join(__dirname, 'native-module', 'natively-audio.darwin-arm64.node');

let m;
try {
    m = require('./native-module');
    console.log('Successfully loaded native module');
} catch (e) {
    console.error('Failed to load:', e);
    process.exit(1);
}

const capture = new m.MicrophoneCapture();
console.log('Created MicrophoneCapture');

capture.start((...args) => {
    console.log('Received data callback args:', args.length);
    console.log('Arg 0 (err?):', args[0]);
    if (args.length > 1) {
        console.log('Arg 1 type:', typeof args[1]);
        if (args[1]) {
            console.log('Arg 1 isBuffer?', Buffer.isBuffer(args[1]));
            console.log('Arg 1 constructor:', args[1].constructor.name);
            console.log('Arg 1 length:', args[1].length);
        }
    }
    capture.stop();
    process.exit(0);
}, (...args) => {
    console.log('Received speech_ended callback args:', args);
});

// Wait a bit
setTimeout(() => {
    console.log('Timeout. No data received.');
    capture.stop();
    process.exit(0);
}, 2000);

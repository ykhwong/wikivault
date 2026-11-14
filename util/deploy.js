const fs = require('node:fs');
const path = require('node:path');
const babel = require('@babel/core');
const JavaScriptObfuscator = require('javascript-obfuscator');

const INPUT_FILE = path.resolve(__dirname, '../frontend/core.js');
const OUTPUT_DIR = path.resolve(__dirname, '../deploy');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'deploy.dat');

function encrypt(text) {
    return text.split("").map(char =>
        String.fromCharCode(char.charCodeAt(0) + 3)
    ).join("");
}

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function readSourceCode(filePath) {
    console.log("Deploying...[0/3]");
    return fs.readFileSync(filePath, 'utf8');
}

function transpileCode(code) {
    console.log("Deploying...[1/3]");
    return babel.transformSync(code, {
        presets: [["@babel/preset-env", { targets: { ie: "8" } }]],
        sourceType: "script",
        generatorOpts: { compact: true },
        configFile: false,
        comments: false
    }).code;
}

function obfuscateCode(code) {
    console.log("Deploying...[2/3]");
    return JavaScriptObfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: false,
        deadCodeInjection: false,
        renameGlobals: true,
        identifierNamesGenerator: 'hexadecimal',
        stringArray: true,
        stringArrayEncoding: ['rc4'],
        stringArrayThreshold: 1,
        stringArrayShuffle: true,
        transformObjectKeys: false,
        unicodeEscapeSequence: false,
        simplify: true
    }).getObfuscatedCode();
}

function deploy() {
    const sourceCode = readSourceCode(INPUT_FILE);
    const transpiledCode = transpileCode(sourceCode);
    const obfuscatedCode = obfuscateCode(transpiledCode);

    ensureDirectoryExists(OUTPUT_DIR);

    console.log("Deploying...[3/3]");
    fs.writeFileSync(OUTPUT_FILE, encrypt(obfuscatedCode), 'utf8');
    console.log("Done");
}

deploy();


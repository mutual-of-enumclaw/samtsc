console.log('samtsc: Loading SAM Framework Tools');
const { execSync } = require('child_process');
const { mkdir, existsSync, writeFileSync, readFileSync, symlinkSync, copyFileSync } = require('../file-system');
const { relative, resolve } = require('path');
const { logger } = require('../logger');
const { EventEmitter } = require('events');
const { SAMCompiledDirectory } = require('./compiled-directory');

class SAMLayerLib extends SAMCompiledDirectory {
    constructor(dirPath, samconfig, buildRoot, events) {
        super(dirPath, samconfig, buildRoot);
        this.isLibrary = true;
        const self = this;
        this.events.on('build-complete', () => { events.emit('layer-change');});
    }
}

class SAMLayer {
    constructor(name, properties, metadata, stackName, buildRoot, samconfig) {
        this.name = name;
        this.buildRoot = buildRoot;
        this.events = new EventEmitter();
        this.stackName = stackName;
        this.samconfig = samconfig;
        this.setConfig(properties, metadata);
        logger.info(`Identified Serverless Layer: ${this.path}`);

        const self = this;
        this.fileEvent(this.packagePath);
    }

    setConfig(properties, metadata) {
        this.path = properties.ContentUri;
        this.sourcePath = this.path;
        if(this.path == '.') {
            logger.info('Constructing stack layer');
            this.path = 'src/layers/stack-layer';
            properties.ContentUri = this.path;
        }

        this.layerName = properties.LayerName || `${this.stackName}-${this.name}`;
        this.packageFolder = 'nodejs/';
        if(metadata && metadata.BuildMethod && metadata.BuildMethod.startsWith('nodejs')) {
            delete metadata.BuildMethod;
            this.packageFolder = '';
            this.copyToNodeJs = true;
        }
        this.packagePath = this.packageFolder + 'package.json';
    }

    fileEvent(filePath) {
        if(filePath != this.packagePath) {
            return;
        }

        let pckFolder = resolve(this.sourcePath, this.packageFolder);
        logger.debug(pckFolder);
        if(!existsSync(this.packagePath)) {
            logger.error(`${this.packagePath} does not exist`);
            return;
        }
        const pckFilePath = resolve(pckFolder, this.packagePath);
        this.pck = JSON.parse(readFileSync(pckFilePath).toString());
        if(!this.pck.dependencies) {
            this.pck.dependencies = {};
        }
        if(this.copyToNodeJs) {
            pckFolder = resolve(this.sourcePath, this.packageFolder, 'nodejs');
        }

        let lock;
        const sourceLockPath = resolve(this.sourcePath, 'package-lock.json');
        if(existsSync(sourceLockPath)) {
            lock = JSON.parse(readFileSync(sourceLockPath));
        }

        if(this.name == this.samconfig.stack_reference_layer && this.sourcePath != '.') {
            console.log('samtsc: Constructing combined dependencies');
            const rootPck = JSON.parse(readFileSync('package.json'));

            const packs = !rootPck.dependencies? [] : Object.keys(rootPck.dependencies).forEach(k => {
                let val = rootPck.dependencies[k];
                if(!val.startsWith('file:')) {
                    this.pck.dependencies[k] = val;
                    return;
                }

                val = val.slice(5);
                let abPath = relative(pckFolder, resolve(val));
                this.pck.dependencies[k] = 'file:' + abPath;
            });

            console.log('samtsc: Construction complete');
        } else if(this.sourcePath == '.') {
            console.log('samtsc: Constructing combined dependencies');

            const packs = !this.pck.dependencies? [] : Object.keys(this.pck.dependencies).forEach(k => {
                let val = this.pck.dependencies[k];
                if(!val.startsWith('file:')) {
                    this.pck.dependencies[k] = val;
                    return;
                }

                val = val.slice(5);
                let abPath = relative(this.path, resolve(val));
                this.pck.dependencies[k] = 'file:' + abPath;
            });

            console.log('samtsc: Construction complete');
        }

        const self = this;
        this.libs = Object.keys(this.pck.dependencies).filter(k => {
            const d = this.pck.dependencies[k];
            if(!d.startsWith('file:')) {
                return false;
            }
            const subpath = resolve(this.path, this.packageFolder, d.slice(5));
            if(!subpath.startsWith(process.cwd())) {
                const localLibDir = resolve(this.buildRoot, 'externals', k);
                mkdir(localLibDir);
                if(!existsSync(resolve(localLibDir, 'package.json'))) {
                    logger.info('Creating local link to lib', subpath);
                    symlinkSync(resolve(subpath, 'package.json'), resolve(localLibDir, 'package.json'), 'file');
                    const tsconfig = JSON.parse(readFileSync(resolve(subpath, 'tsconfig.json')));
                    if(!tsconfig.compilerOptions || !tsconfig.compilerOptions.outDir) {
                        logger.error('External libraries are only supported with an outDir in the tsconfig.  Reference', k);
                        throw new Error('No external library outDir');
                    }
                    
                    mkdir(resolve(localLibDir, tsconfig.compilerOptions.outDir, '..'));

                    symlinkSync(resolve(subpath, tsconfig.compilerOptions.outDir), resolve(localLibDir, tsconfig.compilerOptions.outDir), 'dir');
                }
                this.pck.dependencies[k] = 'file:' + localLibDir;
                if(lock) {
                    lock.dependencies[k].version = this.pck.dependencies[k]
                }
            } else {
                return subpath.startsWith(process.cwd());    
            }
        }).map(k => {
            const d = this.pck.dependencies[k];
            console.log(d.slice(5));
            const fullPath = resolve(this.path, this.packageFolder, d.slice(5));
            const subpath = relative(process.cwd(), fullPath);
            console.log(subpath);
            return new SAMLayerLib(subpath, this.samconfig, this.buildRoot, this.events);
        });

        this.libs.forEach(x => {
            x.buildIfNotPresent()
            x.events.on('build-complete', () => {
                this.events.emit('layer-change', this);
            });
        });

        console.log('samtsc: constructing build directory');
        const addExtraJs = lock? 'nodejs/' : '';
        const nodejsPath = `${this.buildRoot}/${this.path}/${this.packageFolder}${addExtraJs}`;
        mkdir(nodejsPath);

        const pckCopy = JSON.parse(JSON.stringify(this.pck));
        if(pckCopy.dependencies) {
            Object.keys(pckCopy.dependencies).forEach(k => {
                const val = pckCopy.dependencies[k];
                if(!val.startsWith('file:')) {
                    return;
                }

                let refPath = val.slice(5);
                if(addExtraJs) {
                    refPath = '../' + refPath;
                }
                const packFolder = this.sourcePath == '.'? this.path : pckFolder;
                const abPath = resolve(packFolder, refPath);
                if(abPath.startsWith(process.cwd())) {
                    refPath = resolve(nodejsPath, refPath);
                } else {
                    refPath = abPath;
                }
                pckCopy.dependencies[k] = 'file:' + refPath;
                if(lock) {
                    lock.dependencies[k].version = 'file:' + refPath;
                }
            });
        }
        writeFileSync(nodejsPath + 'package.json', JSON.stringify(pckCopy, undefined, 2));
        if(lock) {
            const outputPath = resolve(nodejsPath, 'package-lock.json');
            writeFileSync(outputPath, JSON.stringify(lock, undefined, 2));
            execSync('npm ci --only=prod', { cwd: nodejsPath, stdio: 'inherit' });    
        } else {
            logger.info('samtsc: installing dependencies');
            execSync('npm i --only=prod', { cwd: nodejsPath, stdio: 'inherit' });    
        }

        console.log('samtsc: file change ', filePath);
        this.events.emit('layer-change', this);
    }

    cleanup() {
        this.libs && this.libs.forEach(x => x.cleanup());
    }
}

module.exports.SAMLayer = SAMLayer;

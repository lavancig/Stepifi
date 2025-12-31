const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

const FREECAD = '/opt/conda/bin/freecadcmd';

const FREECAD_ENV = {
  ...process.env,
  QT_QPA_PLATFORM: 'offscreen',
  XDG_RUNTIME_DIR: '/tmp/runtime',
  CONDA_PREFIX: '/opt/conda',
  LD_LIBRARY_PATH: '/opt/conda/lib'
};

class ConverterService {
  constructor() {
    this.pythonScript = path.join(config.paths.pythonScripts, 'convert.py');
  }

  extractJson(stdout) {
    const lastBrace = stdout.lastIndexOf('}');
    if (lastBrace === -1) return null;
    
    let depth = 0;
    for (let i = lastBrace; i >= 0; i--) {
      if (stdout[i] === '}') depth++;
      if (stdout[i] === '{') {
        depth--;
        if (depth === 0) {
          const jsonStr = stdout.substring(i, lastBrace + 1);
          try {
            return JSON.parse(jsonStr);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  async convert(inputPath, outputPath, options = {}) {
    const result = await this.convertWithProcess(inputPath, outputPath, options);
    return result.promise;
  }

  async convertWithProcess(inputPath, outputPath, options = {}) {
    const tolerance = options.tolerance || config.conversion.defaultTolerance;
    const repair = options.repair !== false;
    const skipFaceMerge = options.skipFaceMerge === true;
    const inputFormat = options.inputFormat || 'stl'; // Default to STL
    const outputFormat = options.outputFormat || 'step'; // Default to STEP

    try {
      await fs.access(inputPath);
    } catch {
      return {
        process: null,
        promise: Promise.resolve({ success: false, error: 'Input file not found' })
      };
    }

    const args = [
      this.pythonScript,
      inputPath,
      outputPath,
      tolerance.toString(),
      repair ? 'repair' : 'no-repair',
      inputFormat,
      skipFaceMerge ? 'skip-merge' : 'merge',
      outputFormat
    ];

    logger.info("Running FreeCAD conversion", { 
      cmd: FREECAD, 
      args, 
      inputFormat,
      outputFormat
    });

    const proc = spawn(FREECAD, args, {
      env: FREECAD_ENV,
      timeout: config.conversion.timeout,
      maxBuffer: 50 * 1024 * 1024
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    const promise = new Promise((resolve) => {
      proc.on('close', (code) => {
        logger.info("Process closed", { 
          code, 
          inputFormat,
          outputFormat,
          stdoutLen: stdout.length, 
          stderrLen: stderr.length 
        });
        
        try {
          fsSync.writeFileSync('/tmp/last-stdout.txt', stdout);
          fsSync.writeFileSync('/tmp/last-stderr.txt', stderr);
        } catch (e) {}
        
        const parsed = this.extractJson(stdout);
        
        if (parsed) {
          resolve(parsed);
        } else {
          logger.error("Failed parsing", { 
            format: inputFormat,
            stdoutLen: stdout.length, 
            last200: stdout.substring(Math.max(0, stdout.length - 200)) 
          });
          resolve({
            success: false,
            error: "Failed to parse JSON output from FreeCAD",
            stdout: stdout.substring(Math.max(0, stdout.length - 2000)),
            stderr
          });
        }
      });

      proc.on('error', (err) => {
        logger.error("Spawn error", { error: err.message, format: inputFormat });
        resolve({ success: false, error: err.message });
      });
    });

    return { process: proc, promise };
  }

  async getMeshInfo(inputPath, inputFormat = 'stl') {
    return new Promise((resolve) => {
      const args = [
        this.pythonScript,
        inputPath,
        '/dev/null',
        '0.01',
        'no-repair',
        inputFormat
      ];

      const proc = spawn(FREECAD, args, {
        env: FREECAD_ENV,
        timeout: 30000
      });

      let stdout = '';
      proc.stdout.on('data', (d) => stdout += d.toString());

      proc.on('close', () => {
        const parsed = this.extractJson(stdout);
        resolve(parsed || { success: false, error: "Failed to parse mesh info" });
      });

      proc.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });
    });
  }

  async checkFreecad() {
    return new Promise((resolve) => {
      const proc = spawn(FREECAD, ['--version'], {
        env: FREECAD_ENV,
        timeout: 5000
      });

      let stdout = '';
      proc.stdout.on('data', (d) => stdout += d.toString());

      proc.on('close', (code) => {
        resolve({
          available: code === 0,
          version: stdout.trim()
        });
      });

      proc.on('error', () => resolve({ available: false }));
    });
  }
}

module.exports = new ConverterService();

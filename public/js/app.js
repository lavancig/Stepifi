/**
 * Stepifi - Frontend Application
 */

class STLConverter {
  constructor() {
    this.jobs = new Map();
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.mesh = null;
    this.wireframeMode = false;
    this.db = null;

    this.init();
  }

  async init() {
    this.bindElements();
    this.bindEvents();
    this.initThreeJS();
    await this.initIndexedDB();
    await this.loadJobsFromStorage();
    this.cleanupExpiredJobs();
    // Note: resumePollingJobs is now called inside loadJobsFromStorage
    
    // Periodically sync jobs from server (every 10 seconds)
    setInterval(() => this.syncJobsFromServer(), 10000);
  }

  async syncJobsFromServer() {
    try {
      const response = await fetch('/api/jobs');
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.jobs) {
          // Update jobs map with server data
          const serverJobIds = new Set(data.jobs.map(j => j.id));
          
          // Remove jobs that no longer exist on server
          for (const [jobId] of this.jobs) {
            if (!serverJobIds.has(jobId)) {
              this.jobs.delete(jobId);
              this.deleteSTLFromIndexedDB(jobId);
            }
          }
          
          // Add/update jobs from server
          for (const job of data.jobs) {
            const existingJob = this.jobs.get(job.id);
            
            // Preserve hasPreview from existing job, or check IndexedDB for new jobs
            if (existingJob && existingJob.hasPreview !== undefined) {
              job.hasPreview = existingJob.hasPreview;
            } else {
              // Check if we have preview data in IndexedDB
              const hasData = await this.hasSTLInIndexedDB(job.id);
              job.hasPreview = hasData;
            }
            
            this.jobs.set(job.id, job);
          }
          
          this.saveJobsToStorage();
          this.renderJobs();
        }
      }
    } catch (err) {
      console.error('Failed to sync jobs from server:', err);
    }
  }

  bindElements() {
    this.dropZone = document.getElementById('dropZone');
    this.fileInput = document.getElementById('fileInput');
    this.toleranceInput = document.getElementById('tolerance');
    this.toleranceValue = document.getElementById('toleranceValue');
    this.repairMeshCheckbox = document.getElementById('repairMesh');
    this.skipFaceMergeCheckbox = document.getElementById('skipFaceMerge');
    this.outputFormatSTL = document.getElementById('outputFormatSTL');
    this.outputFormatSTEP = document.getElementById('outputFormatSTEP');
    this.previewSection = document.getElementById('previewSection');
    this.previewContainer = document.getElementById('previewContainer');
    this.previewCanvas = document.getElementById('previewCanvas');
    this.resetViewBtn = document.getElementById('resetView');
    this.toggleWireframeBtn = document.getElementById('toggleWireframe');
    this.vertexCount = document.getElementById('vertexCount');
    this.faceCount = document.getElementById('faceCount');
    this.fileSize = document.getElementById('fileSize');
    this.jobsList = document.getElementById('jobsList');
    this.healthBtn = document.getElementById('healthBtn');
    this.healthModal = document.getElementById('healthModal');
    this.healthContent = document.getElementById('healthContent');
    this.toastContainer = document.getElementById('toastContainer');
  }

  bindEvents() {
    // Drop zone events
    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.dropZone.addEventListener('dragover', (e) => this.handleDragOver(e));
    this.dropZone.addEventListener('dragleave', (e) => this.handleDragLeave(e));
    this.dropZone.addEventListener('drop', (e) => this.handleDrop(e));
    this.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

    // Tolerance slider
    this.toleranceInput.addEventListener('input', () => {
      this.toleranceValue.textContent = this.toleranceInput.value;
    });

    // Preview controls
    this.resetViewBtn.addEventListener('click', () => this.resetCameraView());
    this.toggleWireframeBtn.addEventListener('click', () => this.toggleWireframe());

    // Health modal
    this.healthBtn.addEventListener('click', () => this.showHealthModal());
    this.healthModal.querySelector('.modal-close').addEventListener('click', () => {
      this.healthModal.classList.add('hidden');
    });
    this.healthModal.addEventListener('click', (e) => {
      if (e.target === this.healthModal) {
        this.healthModal.classList.add('hidden');
      }
    });

    // Window resize
    window.addEventListener('resize', () => this.handleResize());
  }

  // IndexedDB for storing STL/3MF files
  async initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('StepifiDB', 1);

      request.onerror = () => {
        console.error('IndexedDB failed to open');
        resolve(); // Continue without DB
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('stlFiles')) {
          db.createObjectStore('stlFiles', { keyPath: 'jobId' });
        }
      };
    });
  }

  async saveSTLToIndexedDB(jobId, arrayBuffer, filename) {
    if (!this.db) return;

    // Only store files under 20MB to avoid filling storage
    if (arrayBuffer.byteLength > 20 * 1024 * 1024) {
      console.log('File too large to store for preview');
      return;
    }

    try {
      const transaction = this.db.transaction(['stlFiles'], 'readwrite');
      const store = transaction.objectStore('stlFiles');
      await store.put({
        jobId: jobId,
        data: arrayBuffer,
        filename: filename,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error('Failed to save file to IndexedDB:', err);
    }
  }

  async loadSTLFromIndexedDB(jobId) {
    if (!this.db) return null;

    try {
      const transaction = this.db.transaction(['stlFiles'], 'readonly');
      const store = transaction.objectStore('stlFiles');
      const request = store.get(jobId);

      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          resolve(null);
        };
      });
    } catch (err) {
      console.error('Failed to load file from IndexedDB:', err);
      return null;
    }
  }

  async deleteSTLFromIndexedDB(jobId) {
    if (!this.db) return;

    try {
      const transaction = this.db.transaction(['stlFiles'], 'readwrite');
      const store = transaction.objectStore('stlFiles');
      await store.delete(jobId);
    } catch (err) {
      console.error('Failed to delete file from IndexedDB:', err);
    }
  }

  async hasSTLInIndexedDB(jobId) {
    if (!this.db) return false;

    try {
      const transaction = this.db.transaction(['stlFiles'], 'readonly');
      const store = transaction.objectStore('stlFiles');
      const request = store.get(jobId);

      return new Promise((resolve) => {
        request.onsuccess = () => {
          resolve(request.result !== undefined);
        };
        request.onerror = () => {
          resolve(false);
        };
      });
    } catch (err) {
      console.error('Failed to check IndexedDB:', err);
      return false;
    }
  }

  // LocalStorage persistence
  async loadJobsFromStorage() {
    try {
      // First, load from localStorage as cache
      const stored = localStorage.getItem('stepifi_jobs');
      if (stored) {
        const jobsArray = JSON.parse(stored);
        jobsArray.forEach(job => {
          this.jobs.set(job.id, job);
        });
      }

      // Then fetch all jobs from server (authoritative source)
      try {
        const response = await fetch('/api/jobs');
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.jobs) {
            // Clear and reload with server jobs
            this.jobs.clear();
            
            // Add jobs and check for preview availability
            for (const job of data.jobs) {
              // Check if we have preview data in IndexedDB
              const hasData = await this.hasSTLInIndexedDB(job.id);
              job.hasPreview = hasData;
              this.jobs.set(job.id, job);
            }
            
            // Save to localStorage
            this.saveJobsToStorage();
            
            // Resume polling for incomplete jobs
            this.resumePollingJobs();
          }
        }
      } catch (fetchErr) {
        console.error('Failed to fetch jobs from server:', fetchErr);
        // Continue with localStorage jobs if server fetch fails
      }

      this.renderJobs();
    } catch (err) {
      console.error('Failed to load jobs:', err);
    }
  }

  saveJobsToStorage() {
    try {
      const jobsArray = Array.from(this.jobs.values());
      localStorage.setItem('stepifi_jobs', JSON.stringify(jobsArray));
    } catch (err) {
      console.error('Failed to save jobs to storage:', err);
    }
  }

  cleanupExpiredJobs() {
    const now = Date.now();
    let removed = 0;
    
    this.jobs.forEach((job, jobId) => {
      if (job.expiresAt) {
        const expiresAt = new Date(job.expiresAt).getTime();
        if (now > expiresAt) {
          this.jobs.delete(jobId);
          this.deleteSTLFromIndexedDB(jobId);
          removed++;
        }
      }
    });
    
    if (removed > 0) {
      this.saveJobsToStorage();
      this.renderJobs();
      console.log(`Cleaned up ${removed} expired jobs`);
    }
  }

  resumePollingJobs() {
    // Resume polling for any incomplete jobs
    this.jobs.forEach((job, jobId) => {
      if (job.status === 'queued' || job.status === 'processing') {
        this.startPollingJob(jobId);
      }
    });
  }

  // File handling
  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.add('drag-over');
  }

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove('drag-over');
  }

  handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove('drag-over');

    const files = Array.from(e.dataTransfer.files).filter(f => {
      const name = f.name.toLowerCase();
      return name.endsWith('.stl') || name.endsWith('.3mf');
    });

    if (files.length === 0) {
      this.showToast('Please drop STL or 3MF files only', 'error');
      return;
    }

    this.processFiles(files);
  }

  handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      this.processFiles(files);
    }
    this.fileInput.value = '';
  }

  async processFiles(files) {
    // Preview the first file immediately (only STL files)
    if (files.length > 0) {
      const firstFile = files[0];
      const is3MF = firstFile.name.toLowerCase().endsWith('.3mf');
      
      if (is3MF) {
        // For 3MF files, show message that preview will be available after conversion
        this.showToast('3MF preview will be available after conversion to STL', 'info');
        // Don't hide the section, just don't try to preview
      } else {
        // STL files can be previewed immediately
        this.previewSTL(firstFile);
      }
    }

    // Upload all files for conversion
    for (const file of files) {
      await this.uploadFile(file);
    }
  }

  async uploadFile(file) {
    const formData = new FormData();
    formData.append('meshFile', file);  // Changed from 'stlFile' to match backend
    formData.append('tolerance', this.toleranceInput.value);
    formData.append('repair', this.repairMeshCheckbox.checked);
    formData.append('skipFaceMerge', this.skipFaceMergeCheckbox.checked);
    formData.append('outputFormat', this.outputFormatSTL.checked ? 'stl' : 'step');

    // Warn for large files
    if (file.size > 5 * 1024 * 1024) {
      this.showToast('Large file detected - conversion may take 15-30 minutes', 'warning');
    }

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();

      if (data.success) {
        this.showToast(`Conversion started: ${file.name}`, 'success');
        
        const outputFormat = this.outputFormatSTL.checked ? 'stl' : 'step';
        const inputFormat = file.name.toLowerCase().endsWith('.3mf') ? '3mf' : 'stl';
        
        // Store file for preview (only for STL files - 3MF preview comes after conversion)
        if (inputFormat === 'stl') {
          const reader = new FileReader();
          reader.onload = async (e) => {
            await this.saveSTLToIndexedDB(data.jobId, e.target.result, file.name);
          };
          reader.readAsArrayBuffer(file);
        }

        this.addJob({
          id: data.jobId,
          filename: file.name,
          originalFilename: file.name,
          status: 'queued',
          progress: 0,
          expiresAt: data.expiresAt,
          fileSize: file.size,
          inputFormat: inputFormat,
          outputFormat: outputFormat,
          hasPreview: inputFormat === 'stl' && file.size <= 20 * 1024 * 1024,
        });
        this.startPollingJob(data.jobId);
      } else {
        this.showToast(`Upload failed: ${data.error}`, 'error');
      }
    } catch (err) {
      this.showToast(`Upload error: ${err.message}`, 'error');
    }
  }

  // Job management
  addJob(job) {
    this.jobs.set(job.id, job);
    this.saveJobsToStorage();
    this.renderJobs();
  }

  updateJob(jobId, updates) {
    const job = this.jobs.get(jobId);
    if (job) {
      Object.assign(job, updates);
      this.saveJobsToStorage();
      this.renderJobs();
    }
  }

  removeJob(jobId) {
    this.jobs.delete(jobId);
    this.deleteSTLFromIndexedDB(jobId);
    this.saveJobsToStorage();
    this.renderJobs();
  }

  async startPollingJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let pollCount = 0;
    const maxPolls = 1000; // 50 minutes at 3 second intervals

    const poll = async () => {
      pollCount++;

      // Check if we should stop polling
      if (pollCount > maxPolls) {
        this.updateJob(jobId, { 
          status: 'timeout', 
          error: 'Polling timeout - please refresh to check status',
          message: 'Polling timed out. Click refresh to check current status.'
        });
        return;
      }

      try {
        const response = await fetch(`/api/job/${jobId}`);
        const data = await response.json();

        if (data.success) {
          const job = data.job;
          
          // Add estimate for large files
          let message = job.message;
          if (job.status === 'processing' && this.jobs.get(jobId)?.fileSize > 5 * 1024 * 1024) {
            message = `Processing large file (may take 15-30 min)... ${message || ''}`;
          }

          this.updateJob(jobId, {
            status: job.status,
            progress: job.progress,
            message: message,
            result: job.result,
            error: job.error,
            expiresIn: job.expiresIn,
          });

          if (job.status === 'completed') {
            this.showToast(`Conversion completed: ${this.jobs.get(jobId)?.filename}`, 'success');
            
            // Fetch and preview converted STL files for 3MF inputs
            const jobData = this.jobs.get(jobId);
            if (jobData && jobData.inputFormat === '3mf' && job.outputFormat === 'stl') {
              await this.fetchAndPreviewConvertedSTL(jobId);
            }
            
            return;
          }

          if (job.status === 'failed') {
            this.showToast(`Conversion failed: ${job.error || 'Unknown error'}`, 'error');
            return;
          }

          // Continue polling - increase interval for long-running jobs
          const pollInterval = pollCount > 20 ? 5000 : 3000; // 5s after 1 minute
          setTimeout(poll, pollInterval);
        } else {
          // Job not found - might be expired
          if (response.status === 404) {
            this.updateJob(jobId, { 
              status: 'expired', 
              error: 'Job expired or not found',
              message: 'Job expired. Please convert again.'
            });
          } else {
            // Retry on error
            setTimeout(poll, 3000);
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
        // Retry on network error
        setTimeout(poll, 3000);
      }
    };

    poll();
  }

  renderJobs() {
    if (this.jobs.size === 0) {
      this.jobsList.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-inbox"></i>
          <p>No active conversions</p>
        </div>
      `;
      return;
    }

    const jobsArray = Array.from(this.jobs.values()).reverse();

    this.jobsList.innerHTML = jobsArray.map(job => `
      <div class="job-card" data-job-id="${job.id}">
        <div class="job-header">
          <div class="job-info">
            <h4>${this.escapeHtml(job.originalFilename || job.filename || 'Unknown file')}</h4>
            <div class="job-meta">
              ${job.fileSize ? `<span><i class="fas fa-file"></i> ${this.formatFileSize(job.fileSize)}</span>` : ''}
              ${job.expiresIn ? `<span><i class="fas fa-clock"></i> ${this.formatTimeRemaining(job.expiresIn)}</span>` : ''}
            </div>
          </div>
          <div class="job-status ${job.status}">
            ${this.getStatusIcon(job.status)}
            ${this.capitalizeFirst(job.status)}
          </div>
        </div>
        <div class="job-progress">
          <div class="job-progress-bar ${job.status}" style="width: ${job.progress}%"></div>
        </div>
        ${job.message ? `<div class="job-message ${job.error ? 'error' : ''}">${this.escapeHtml(job.message)}</div>` : ''}
        <div class="job-actions">
          ${job.hasPreview ? `
            <button class="btn btn-ghost btn-sm" onclick="app.previewJob('${job.id}')" title="Preview">
              <i class="fas fa-eye"></i> Preview
            </button>
          ` : ''}
          ${job.status === 'completed' ? `
            <button class="btn btn-success btn-sm" onclick="app.downloadJob('${job.id}')">
              <i class="fas fa-download"></i> Download ${(job.outputFormat || 'step').toUpperCase()}
            </button>
          ` : ''}
          ${(job.status === 'queued' || job.status === 'processing') ? `
            <button class="btn btn-primary btn-sm" onclick="app.refreshJob('${job.id}')">
              <i class="fas fa-sync"></i> Refresh
            </button>
            <button class="btn btn-danger btn-sm" onclick="app.cancelJob('${job.id}')">
              <i class="fas fa-times"></i> Cancel
            </button>
          ` : ''}
          <button class="btn btn-ghost btn-sm" onclick="app.deleteJob('${job.id}')">
            <i class="fas fa-trash"></i>
          </button>
        </div>
      </div>
    `).join('');
  }

  async previewJob(jobId) {
    const stlData = await this.loadSTLFromIndexedDB(jobId);
    
    if (!stlData) {
      this.showToast('Preview not available for this file', 'error');
      return;
    }
    
    // Skip 3MF files - they can't be previewed with this method
    if (stlData.filename && stlData.filename.toLowerCase().endsWith('.3mf')) {
      this.showToast('3MF preview not available. Please convert to STL first.', 'info');
      return;
    }
    
    // Check if data is valid
    if (!stlData.data || !stlData.data.byteLength) {
      this.showToast('Preview data is corrupted. Please re-upload.', 'error');
      return;
    }

    this.previewSTL(new File([stlData.data], stlData.filename));
  }

  async refreshJob(jobId) {
    try {
      const response = await fetch(`/api/job/${jobId}`);
      const data = await response.json();

      if (data.success) {
        const job = data.job;
        this.updateJob(jobId, {
          status: job.status,
          progress: job.progress,
          message: job.message,
          result: job.result,
          error: job.error,
          expiresIn: job.expiresIn,
        });
        this.showToast('Job status refreshed', 'success');

        // Resume polling if still in progress
        if (job.status === 'processing' || job.status === 'queued') {
          this.startPollingJob(jobId);
        }
      } else {
        this.showToast('Failed to refresh job', 'error');
      }
    } catch (err) {
      this.showToast('Failed to refresh job', 'error');
    }
  }

  async fetchAndPreviewConvertedSTL(jobId) {
    try {
      const response = await fetch(`/api/download/${jobId}`);
      if (!response.ok) {
        console.error('Failed to fetch converted STL for preview');
        return;
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer(); // Convert to ArrayBuffer
      const jobData = this.jobs.get(jobId);
      const filename = jobData?.originalFilename?.replace(/\.3mf$/i, '.stl') || 'converted.stl';
      
      // Store in IndexedDB for preview
      await this.saveSTLToIndexedDB(jobId, arrayBuffer, filename);
      
      // Update job to mark preview as available
      this.updateJob(jobId, { hasPreview: true });
      
      // If this is the most recent job, show the preview
      const jobs = Array.from(this.jobs.values());
      const mostRecent = jobs.sort((a, b) => 
        new Date(b.createdAt) - new Date(a.createdAt)
      )[0];
      
      if (mostRecent?.id === jobId) {
        // Show preview for the most recently completed job
        const file = new File([arrayBuffer], filename, { type: 'application/octet-stream' });
        this.previewSTL(file);
        this.showToast('3D preview ready', 'success');
      }
    } catch (err) {
      console.error('Failed to fetch converted STL:', err);
      // Silent fail - preview is optional
    }
  }

  async downloadJob(jobId) {
    window.location.href = `/api/download/${jobId}`;
  }

  async cancelJob(jobId) {
    try {
      await fetch(`/api/job/${jobId}`, { method: 'DELETE' });
      this.removeJob(jobId);
      this.showToast('Job cancelled', 'warning');
    } catch (err) {
      this.showToast('Failed to cancel job', 'error');
    }
  }

  async deleteJob(jobId) {
    try {
      await fetch(`/api/job/${jobId}`, { method: 'DELETE' });
      this.removeJob(jobId);
      this.showToast('Job deleted', 'success');
    } catch (err) {
      this.showToast('Failed to delete job', 'error');
    }
  }

  // Three.js Preview
  initThreeJS() {
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1419);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      45,
      this.previewContainer.clientWidth / this.previewContainer.clientHeight,
      0.1,
      10000
    );
    this.camera.position.set(100, 100, 100);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.previewCanvas,
      antialias: true,
    });
    this.renderer.setSize(this.previewContainer.clientWidth, this.previewContainer.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Controls
    this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);

    const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight1.position.set(1, 1, 1);
    this.scene.add(directionalLight1);

    const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
    directionalLight2.position.set(-1, -1, -1);
    this.scene.add(directionalLight2);

    // Grid
    const gridHelper = new THREE.GridHelper(200, 20, 0x2f3640, 0x1a1f26);
    this.scene.add(gridHelper);

    // Animation loop
    const animate = () => {
      requestAnimationFrame(animate);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  previewSTL(file) {
    // Always show preview section when previewing
    this.previewSection.style.display = 'flex';
    
    this.showToast('Loading 3D preview...', 'info');

    const reader = new FileReader();
    const fileName = file.name.toLowerCase();

    reader.onload = (e) => {
      try {
        let geometry;
        
        // Only support STL files
        if (fileName.endsWith('.3mf')) {
          this.showToast('3MF preview not supported. Convert to STL first.', 'error');
          return;
        }
        
        // Load STL
        const loader = new THREE.STLLoader();
        geometry = loader.parse(e.target.result);

        // Remove existing mesh
        if (this.mesh) {
          this.scene.remove(this.mesh);
          this.mesh.geometry.dispose();
          this.mesh.material.dispose();
        }

        // Create material
        const material = new THREE.MeshPhongMaterial({
          color: 0x1d9bf0,  // Blue for STL
          specular: 0x444444,
          shininess: 30,
          flatShading: false,
        });

        // Create mesh
        this.mesh = new THREE.Mesh(geometry, material);

        // Center the model
        geometry.computeBoundingBox();
        const center = new THREE.Vector3();
        geometry.boundingBox.getCenter(center);
        geometry.center();

        // Scale to fit view
        const size = new THREE.Vector3();
        geometry.boundingBox.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 100 / maxDim;
        this.mesh.scale.set(scale, scale, scale);

        this.scene.add(this.mesh);

        // Update info
        this.vertexCount.textContent = geometry.attributes.position.count.toLocaleString();
        this.faceCount.textContent = (geometry.attributes.position.count / 3).toLocaleString();
        this.fileSize.textContent = this.formatFileSize(file.size);

        // Reset camera
        this.resetCameraView();

        this.showToast('3D preview loaded!', 'success');
      } catch (err) {
        console.error('Failed to load file:', err);
        this.showToast('Failed to load 3D preview', 'error');
      }
    };

    reader.onerror = () => {
      this.showToast('Failed to read file', 'error');
    };

    reader.readAsArrayBuffer(file);
  }

  resetCameraView() {
    this.camera.position.set(100, 100, 100);
    this.camera.lookAt(0, 0, 0);
    this.controls.reset();
  }

  toggleWireframe() {
    if (!this.mesh) return;

    this.wireframeMode = !this.wireframeMode;
    this.mesh.material.wireframe = this.wireframeMode;

    this.toggleWireframeBtn.classList.toggle('active', this.wireframeMode);
  }

  handleResize() {
    if (!this.renderer || !this.camera) return;

    const width = this.previewContainer.clientWidth;
    const height = this.previewContainer.clientHeight;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  // Health modal
  async showHealthModal() {
    this.healthModal.classList.remove('hidden');
    this.healthContent.innerHTML = `
      <div class="loading">
        <i class="fas fa-spinner fa-spin"></i>
        <p>Checking system health...</p>
      </div>
    `;

    try {
      const response = await fetch('/health');
      const data = await response.json();

      this.healthContent.innerHTML = `
        <div class="health-status">
          <div class="health-item">
            <div class="health-item-label">
              <i class="fas fa-heartbeat"></i>
              <span>Overall Status</span>
            </div>
            <span class="health-badge ${data.status === 'healthy' ? 'healthy' : 'unhealthy'}">
              ${data.status}
            </span>
          </div>
          <div class="health-item">
            <div class="health-item-label">
              <i class="fas fa-database"></i>
              <span>Redis</span>
            </div>
            <span class="health-badge ${data.redis ? 'healthy' : 'unhealthy'}">
              ${data.redis ? 'Connected' : 'Disconnected'}
            </span>
          </div>
          <div class="health-item">
            <div class="health-item-label">
              <i class="fas fa-cube"></i>
              <span>FreeCAD</span>
            </div>
            <span class="health-badge ${data.freecad ? 'healthy' : 'unhealthy'}">
              ${data.freecad ? 'Available' : 'Not Available'}
            </span>
          </div>
          ${data.freecadVersion ? `
            <div class="health-item">
              <div class="health-item-label">
                <i class="fas fa-code-branch"></i>
                <span>FreeCAD Version</span>
              </div>
              <span style="color: var(--text-secondary); font-size: 0.85rem;">
                ${data.freecadVersion}
              </span>
            </div>
          ` : ''}
        </div>
      `;
    } catch (err) {
      this.healthContent.innerHTML = `
        <div class="health-status">
          <div class="health-item">
            <div class="health-item-label">
              <i class="fas fa-exclamation-triangle"></i>
              <span>Error</span>
            </div>
            <span class="health-badge unhealthy">Failed to check health</span>
          </div>
        </div>
      `;
    }
  }

  // Utilities
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle',
    };

    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info}"></i>
      <span>${this.escapeHtml(message)}</span>
    `;

    this.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  formatTimeRemaining(seconds) {
    if (!seconds || seconds <= 0) return 'Expired';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  getStatusIcon(status) {
    const icons = {
      queued: '<i class="fas fa-hourglass-start"></i>',
      processing: '<i class="fas fa-spinner fa-spin"></i>',
      completed: '<i class="fas fa-check"></i>',
      failed: '<i class="fas fa-times"></i>',
      timeout: '<i class="fas fa-clock"></i>',
      expired: '<i class="fas fa-hourglass-end"></i>',
    };
    return icons[status] || '';
  }

  capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Initialize app
const app = new STLConverter();

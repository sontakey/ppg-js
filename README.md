# PPG Vitals Monitor

**Real-time photoplethysmography (PPG) signal monitoring using smartphone camera**

A JavaScript library for capturing and analyzing PPG signals through camera-based photoplethysmography, providing real-time vital signs monitoring including heart rate, signal quality metrics, and active user guidance.

## 🌐 Live Demo

Visit the demo: [https://sontakey.github.io/ppg-vitals/](https://sontakey.github.io/ppg-vitals/)

## ✨ Features

- 📹 **Real-time camera-based PPG signal acquisition** at 60 FPS
- 📊 **Advanced signal quality metrics**: SNR, Perfusion Index, Heart Rate, IBI
- 🎯 **Visual feedback** with color-coded finger placement guide
- 💬 **Active user guidance** for optimal signal quality
- 🎨 **Beautiful default UI** with customization support
- 🔧 **Headless mode** for custom integrations
- ⚡ **High performance** - maintains 60 FPS with < 1% overhead
- 📦 **Zero external dependencies** (all bundled)
- 🚀 **Easy integration** - drop-in library or npm package

## 📦 Installation

### NPM

```bash
npm install ppg-vitals
```

### CDN

```html
<link rel="stylesheet" href="https://unpkg.com/ppg-vitals/dist/ppg-monitor.css">
<script src="https://unpkg.com/ppg-vitals/dist/ppg-monitor.min.js"></script>
```

### Direct Download

Download the latest release from [GitHub Releases](https://github.com/sontakey/ppg-js/releases)

## 🚀 Quick Start

### Basic Usage (Default UI)

```javascript
import PPGMonitor from 'ppg-vitals';
import 'ppg-vitals/dist/ppg-monitor.css';

// Create monitor instance
const ppg = new PPGMonitor('#container');

// Start monitoring
ppg.start();
```

### Headless Mode (Custom UI)

```javascript
const ppg = new PPGMonitor(null, {
  ui: { enabled: false },

  onQualityUpdate: (metrics) => {
    console.log('SNR:', metrics.snr_dB, 'dB');
    console.log('Heart Rate:', metrics.heartRate, 'BPM');
    console.log('Perfusion Index:', metrics.perfusionIndex, '%');
    console.log('Status:', metrics.qualityStatus);

    // Update your custom UI
    updateCustomUI(metrics);
  },

  onSignalUpdate: (signal) => {
    // Real-time signal data
    renderCustomChart(signal);
  }
});

ppg.start();
```

### Browser (UMD)

```html
<div id="ppg-container"></div>

<script src="https://unpkg.com/ppg-vitals/dist/ppg-monitor.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/ppg-vitals/dist/ppg-monitor.css">

<script>
  const ppg = new PPGMonitor('#ppg-container');
  ppg.start();
</script>
```

## 📖 API Reference

### Constructor

```javascript
new PPGMonitor(container, options)
```

**Parameters:**
- `container` (string|HTMLElement|null): Container element or CSS selector. Pass `null` for headless mode.
- `options` (Object): Configuration options

**Options:**

```javascript
{
  // UI options
  ui: {
    enabled: true,          // Enable default UI
    showVideo: true,        // Show camera preview
    showMetrics: true,      // Show quality metrics panel
    showChart: true,        // Show real-time chart
    theme: 'light'          // UI theme (future feature)
  },

  // Signal processing options
  signal: {
    windowLength: 300,      // Window size in samples (5s @ 60 FPS)
    sampleRate: 60,         // Target sample rate in Hz
    cardiacBandLow: 0.75,   // Lower cardiac frequency in Hz (45 BPM)
    cardiacBandHigh: 4.0,   // Upper cardiac frequency in Hz (240 BPM)
    fftSize: 256            // FFT size (power of 2)
  },

  // Camera constraints
  camera: {
    maxWidth: 1280,
    maxHeight: 720,
    frameRate: { ideal: 60 },
    facingMode: 'environment'  // 'user' for front camera
  },

  // Callbacks
  onReady: () => {},              // Called when monitoring starts
  onQualityUpdate: (metrics) => {},  // Called every ~5 seconds with quality metrics
  onSignalUpdate: (signal) => {},    // Called on each frame with signal data
  onFrame: (data) => {},             // Called on each processed frame
  onError: (error) => {}             // Called on errors
}
```

### Methods

#### `start()`
Start PPG monitoring.

```javascript
await ppg.start();
```

Returns: `Promise<void>`

#### `stop()`
Stop PPG monitoring and release camera.

```javascript
ppg.stop();
```

#### `getMetrics()`
Get current signal quality metrics.

```javascript
const metrics = ppg.getMetrics();
// Returns: { snr_dB, perfusionIndex, heartRate, ibi, qualityStatus, guidanceMessage, ... }
```

#### `getSignalQuality()`
Get current signal quality status.

```javascript
const status = ppg.getSignalQuality();
// Returns: "Excellent" | "Good" | "Fair" | "Poor"
```

#### `destroy()`
Destroy the monitor and cleanup all resources.

```javascript
ppg.destroy();
```

### Metrics Object

The `metrics` object passed to `onQualityUpdate` contains:

```javascript
{
  snr_dB: number,              // Signal-to-Noise Ratio in dB
  perfusionIndex: number,      // Perfusion Index (%)
  heartRate: number,           // Heart rate in BPM
  ibi: number,                 // Inter-Beat Interval in ms
  signalStability: number,     // Signal stability (0-1)
  qualityStatus: string,       // "Excellent" | "Good" | "Fair" | "Poor"
  guidanceMessage: string,     // User guidance text
  qualityFrameCount: number    // Count of high-quality frames
}
```

## 🎓 How It Works

The library uses your smartphone's camera and flashlight to capture photoplethysmography (PPG) signals:

1. **Signal Acquisition**: Camera captures color changes in fingertip at 60 FPS
2. **Red Channel Extraction**: Only red channel is used for PPG signal
3. **Detrending**: Linear detrending removes baseline drift every 5 seconds
4. **FFT Analysis**: Fast Fourier Transform analyzes frequency components
5. **SNR Calculation**: Signal power in cardiac band (0.75-4.0 Hz) vs noise
6. **Quality Metrics**: Real-time calculation of SNR, Perfusion Index, heart rate
7. **User Guidance**: Context-aware messages guide users to optimal placement

### Signal Quality Thresholds

- **Excellent**: SNR > 10 dB (green indicator)
- **Good**: SNR 5-10 dB (light green indicator)
- **Fair**: SNR 0-5 dB (yellow indicator)
- **Poor**: SNR < 0 dB (red indicator)

## 📱 Usage Instructions

1. Click the "Measure" button
2. Grant camera and flashlight permissions
3. Cover both camera **and** flashlight with your finger
4. Wait for the finger guide circle to turn green
5. Follow on-screen guidance messages:
   - "Cover camera completely" → No signal detected
   - "Press finger more firmly" → Low perfusion
   - "Hold finger still" → Motion detected
   - "Good signal - hold steady" → Optimal signal

## 🌐 Browser Compatibility

- Chrome/Edge 89+
- Safari 14.1+
- Firefox 88+
- Mobile browsers with camera access

**Requirements:**
- HTTPS (required for camera access)
- getUserMedia API support
- ImageCapture API for flashlight (optional but recommended)

## 📝 Examples

Check the `examples/` directory for:
- **[basic](examples/basic/)** - Simple usage with default UI
- **[headless](examples/headless/)** - Custom UI with callbacks
- **[demo](examples/demo/)** - Original demo application

## 🔬 Research & Medical Disclaimer

This library is for **demonstration and research purposes only**. It is **not** a certified medical device and should **not** be used for medical diagnosis or treatment.

The goal of this project is to demonstrate that:
1. Modern smartphones can capture good quality PPG signals
2. Signal quality can be quantified and optimized
3. The captured signals can potentially be used for cardiovascular metrics research

## 🛠️ Development

### Build from Source

```bash
# Clone repository
git clone https://github.com/sontakey/ppg-js.git
cd ppg-js

# Install dependencies
npm install

# Build library
npm run build

# Serve examples locally
npm run serve
```

### Project Structure

```
ppg-vitals/
├── src/
│   ├── PPGMonitor.js           # Main monitor class
│   ├── SignalProcessor.js      # Signal processing logic
│   ├── UIRenderer.js           # UI rendering
│   ├── components/
│   │   └── RealTimeChart.js    # D3.js chart component
│   ├── utils/
│   │   ├── detrend.js          # Linear detrending
│   │   ├── fft.js              # FFT operations
│   │   └── helpers.js          # Helper functions
│   ├── styles/
│   │   └── ppg-monitor.css     # Styles
│   └── index.js                # Entry point
├── dist/                       # Build outputs
├── examples/                   # Usage examples
└── package.json
```

## 📚 References

[1] Vandenberk T, et al. "Clinical Validation of Heart Rate Apps" JMIR Mhealth Uhealth 2017;5(8):e129
[https://mhealth.jmir.org/2017/8/e129](https://mhealth.jmir.org/2017/8/e129)

## 📄 License

MIT License - see [LICENSE](LICENSE) file

## 👤 Author

Sameer Shariff

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## ⭐ Show Your Support

Give a ⭐️ if this project helped you!

## 📞 Contact

For questions or feedback, please open an issue on GitHub.

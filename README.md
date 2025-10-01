# Prose Polisher (Slop Analyzer)

A sophisticated SillyTavern extension that identifies repetitive phrasing patterns in AI-generated text and provides actionable insights through a dynamic macro system. Perfect for writers and roleplayers looking to improve prose quality and reduce repetitive language patterns.

## 🌟 Key Features

### **Smart Pattern Detection**
- **Advanced Pattern Recognition**: Automatically groups similar phrases into template patterns with variant lists (e.g., "a flicker of {anger/doubt/surprise}")
- **Multi-Pattern Support**: Detects prefix, suffix, and middle-slot patterns for comprehensive coverage
- **Statistical Scoring**: Weighted scoring system considering n-gram length, uncommon word frequency, blacklist weights, and context type

### **Performance Optimized**
- **Client-Side Processing**: All analysis happens locally without server dependencies
- **Responsive Design**: Batch processing and debounced updates prevent UI freezing even with long chat histories
- **Configurable Sampling**: Optional message limits and automatic analysis intervals for optimal performance

### **Flexible Configuration**
- **Auto/Manual Analysis**: Choose between automatic continuous monitoring or manual on-demand analysis
- **Customizable Thresholds**: Adjust sensitivity settings to match your specific needs
- **Advanced Options**: Toggle bigram analysis, skip-gram matching, significance weighting, and name masking


## 🔧 How It Works

### 1. Text Preprocessing
- Strips HTML/markdown and code blocks from AI messages
- Splits text into sentences to prevent cross-sentence pattern contamination
- Applies lemmatization and tokenization with name/number masking

### 2. N-gram Analysis
- Generates word chunks (n-grams) from configurable size ranges (default: 3-15 words)
- Separates narration and dialogue for context-aware scoring
- Tracks frequency, message distribution, and significance metrics

### 3. Pattern Detection
- **Prefix Patterns**: Identifies shared beginnings with variable endings
- **Suffix Patterns**: Detects common endings with variable beginnings
- **Middle-Slot Patterns**: Finds phrases with variable middle components between fixed anchors
- **Deduplication**: Merges overlapping patterns and removes redundancies

### 4. Scoring System
- **Base Score**: Calculated from phrase length, word quality, and repetition frequency
- **Weight Modifiers**: Applies blacklist boosts and whitelist protections
- **Decay Mechanism**: Gradually reduces scores for older phrases to maintain relevance
- **Significance Weighting**: Optional PMI (Pointwise Mutual Information) for linguistic relevance

### 5. Output Generation
- Caches processed data for rapid macro expansion
- Provides structured JSON output with patterns and individual phrases
- Updates dynamically as new analysis results become available

## 📊 Macro Output

The `{{slopList}}` macro returns a JSON array ordered by score, containing both pattern templates and individual phrases:

```json
[
  {
    "pattern_template": "a flicker of {variant}",
    "variants": ["anger crossed his face", "doubt crossed her face", "surprise filled his eyes"],
    "score": 12.5,
    "type": "pattern"
  },
  {
    "phrase": "her heart pounded in her chest",
    "score": 8.0,
    "type": "phrase"
  },
  {
    "pattern_template": "with a {variant} expression",
    "variants": ["puzzled", "thoughtful", "concerned"],
    "score": 7.2,
    "type": "pattern"
  }
]
```

**Pattern entries** include:
- `pattern_template`: Template with `{variant}` placeholder
- `variants`: Array of specific phrase variations
- `score`: Weighted repetition score (1.0-10.0)
- `type`: Always "pattern" for template entries

**Phrase entries** include:
- `phrase`: The complete repetitive phrase
- `score`: Weighted repetition score (1.0-10.0)
- `type`: Always "phrase" for individual entries

## ⚙️ Configuration

### **Analysis Settings**
- **Max N-gram Size** (3-15): Maximum phrase length to analyze
- **Slop Threshold** (1.0-10.0): Minimum score for pattern detection
- **Pattern Min Common Words** (2-5): Minimum shared words for pattern merging
- **Score Decay Rate** (0-50%): Percentage reduction per decay cycle
- **Decay Interval** (5-50 messages): Messages between decay applications

### **Performance Settings**
- **Auto-analyze Messages**: Toggle automatic continuous monitoring
- **Analysis Interval** (10-100 messages): Frequency of automatic analysis
- **Message Limit** (-1 to 1000): Restrict analysis to recent messages

### **Advanced Options**
- **Mask Names**: Replace whitelisted names with "NAME" placeholder
- **Enable Bigrams**: Include 2-word phrases in analysis
- **Allow Skip-grams**: Match phrases with modifier variations
- **Use Significance**: Apply PMI-based linguistic relevance weighting
- **Pattern Types**: Enable/disable prefix, suffix, and middle-slot detection
- **Include Standalone**: Show individual phrases outside of patterns

## 🎯 User Interface

### **Analysis Tools**
- **Analyze Chat History**: Manual full-chat analysis with configurable message limits
- **View Frequency Data**: Interactive popup showing detected patterns and scores
- **Clear Frequency Data**: Reset all collected statistics and start fresh

### **List Management**
- **Whitelist Manager**: Curate approved words/characters to ignore during analysis
- **Blacklist Manager**: Assign weights (1-10) to words that should increase detection priority

### **Real-time Feedback**
- Visual indicators for analysis progress and results
- Color-coded pattern identification in frequency tables
- Responsive design that works across different screen sizes

## 🔌 Integration API

### **Macro System**
```javascript
// In prompts or other extensions
const slopData = JSON.parse('{{slopList}}');
console.log(`Found ${slopData.length} repetitive patterns`);
```

### **Extension Methods**
```javascript
// Trigger silent analysis (useful before generation)
await window.ProsePolisher.performSilentAnalysis();

// Get current results as structured data
const currentSlop = window.ProsePolisher.getSlopList();

// Force refresh of analysis and macro
await window.ProsePolisher.updateAnalysis();
```

### **Event System**
The extension automatically integrates with SillyTavern's event system:
- `MESSAGE_RECEIVED`: Analyzes new AI messages when auto-analysis is enabled
- `GENERATION_STARTED`: Pre-generation analysis for fresh macro data
- `CHAT_CHANGED`: Clears data when switching conversations

## 📁 File Structure

```
ProsePolisher/
├── manifest.json          # Extension metadata and dependencies
├── content.js            # Main extension logic, UI, and event handling
├── analyzer.js           # Core analysis engine and pattern detection
├── styles.css            # UI styling for drawer components and popups
├── common_words.js       # Common word filters for quality control
├── lemmas.js            # Lemmatization dictionary for word normalization
├── default_names.js     # Default character names for auto-filtering
└── README.md            # This documentation file
```

### **Recommended Workflow**

1. **Start with Default Settings**: The default configuration works well for most use cases
2. **Analyze Sample Data**: Run analysis on a few conversations to establish baselines
3. **Fine-tune Thresholds**: Adjust the Slop Threshold based on your tolerance for repetition
4. **Curate Lists**: Add character names and jargon to your whitelist for better results

## 🛠️ Technical Details

### **Performance Considerations**
- Uses web workers and batch processing to maintain UI responsiveness
- Implements debounced updates to prevent excessive processing
- Limits analysis scope through configurable message restrictions
- Caches results to minimize redundant computations

### **Pattern Detection Algorithms**
- **Trie-based Analysis**: Efficient prefix/suffix pattern identification
- **Sliding Window**: Middle-slot pattern detection with configurable anchors
- **Similarity Scoring**: Advanced overlap detection with configurable thresholds
- **Deduplication**: Multi-pass pattern merging to eliminate redundancies

### **Statistical Methods**
- **Frequency Analysis**: Tracks both absolute and relative phrase frequencies
- **Decay Functions**: Time-based score reduction for maintaining relevance
- **Significance Weighting**: Optional PMI calculations for linguistic relevance
- **Context Awareness**: Separate scoring for dialogue vs. narration contexts

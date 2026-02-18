const express = require('express')
const app = express()
const port = 5000
const mongoose = require('mongoose');
const { MongoClient } = require("mongodb");
const multer = require("multer");
const fs = require("fs");
const { google } = require("googleapis");
const cors = require("cors");
const path = require("path");
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
}));
app.use(express.json());
require('dotenv').config();

const mongoURI = process.env.MONGO_URI;
let db;
mongoose
  .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log("✅ MongoDB connected!");
    db = mongoose.connection.db;
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

app.use((req, res, next) => {
  if (!db) {
    return res.status(503).json({ success: false, message: "⚠ Database not initialized yet. Please try again later." });
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use(express.json())
app.use('/api/', require("./routes/createUser"));

const dbName = "synergic";
const request_details = "paper_details";
const saved_paper_details="saved_details"
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

const upload = multer({ dest: "uploads/" });

const fileSchema = new mongoose.Schema({
  filename: String,
  driveLink: String,
  yearOfStudy: String,
  branch: String,
  semester: String,
  subject: String,
  uploadedAt: { type: Date, default: Date.now },
});

const FileModel = mongoose.model(request_details, fileSchema);

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: "v3", auth: oauth2Client });

async function checkDriveAccess() {
  try {
    await drive.files.list({ pageSize: 1 });
    console.log("✅ Google Drive API is working!");
  } catch (error) {
    console.error("❌ Google Drive API authentication failed:", error.message);
  }
}
checkDriveAccess();

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    // 1. Validate File Existence
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // 2. Destructure fields including the new 'type'
    const { subject, year, type, contributorName } = req.body;
    
    if (!year || !subject || !type || !contributorName) {
      // Cleanup uploaded file from local storage if validation fails
      if (req.file.path) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Missing required fields: year, subject, type, or contributorName" });
    }

    // 3. Upload to Google Drive
    const fileMetadata = { name: req.file.originalname };
    const media = { 
      mimeType: req.file.mimetype, 
      body: fs.createReadStream(req.file.path) 
    };

    const driveResponse = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: "id",
    });

    const fileId = driveResponse.data.id;
    if (!fileId) throw new Error("Failed to generate File ID from Google Drive");

    // 4. Delete temporary file from server immediately after upload
    fs.unlinkSync(req.file.path);

    // 5. Set Permissions & Get Public Link
    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    const fileInfo = await drive.files.get({ 
      fileId: fileId, 
      fields: "webViewLink" 
    });
    const fileLink = fileInfo.data.webViewLink;

    // 6. Database Operations (Targeting 'synergic' DB)
    const synergicDb = mongoose.connection.useDb("synergic");

    // Define or use an existing Schema
    const fileSchema = new mongoose.Schema({
      filename: String,
      driveLink: String,
      yearOfStudy: String,
      subject: String,
      type: String, // 'Mid Sem', 'End Sem', etc.
      contributorName: String,
      uploadedAt: { type: Date, default: Date.now },
    });

    // Ensure model is correctly named as a string "request_details"
    const FileModel = synergicDb.model("paper_details", fileSchema);

    const newFile = new FileModel({
      filename: req.file.originalname,
      driveLink: fileLink,
      yearOfStudy: year,
      subject: subject,
      type: type,
      contributorName: contributorName,
    });

    await newFile.save();

    res.json({ success: true, fileId: fileId, link: fileLink });

  } catch (error) {
    // Cleanup local file if an error occurs during the Drive upload process
    if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
    }
    console.error("❌ Upload error:", error.message);
    res.status(500).json({ error: "Failed to upload file to system" });
  }
});







app.get("/questionpapers/:year/:subject", async (req, res) => {
  try {
    const { year, subject } = req.params;
    const papers = await FileModel.find({ subject, yearOfStudy: year });

    if (!papers.length) {
      return res.status(404).json({ success: false, message: "No papers found" });
    }

    res.json({ success: true, papers });
  } catch (error) {
    console.error("❌ Error fetching papers:", error.message);
    res.status(500).json({ error: "Failed to retrieve question papers" });
  }
});

app.delete("/delete/:id", async (req, res) => {
  try {
    const fileId = req.params.id;

    await drive.files.delete({ fileId });

    await FileModel.deleteOne({ driveLink: { $regex: fileId } });

    res.json({ success: true, message: "File deleted successfully" });
  } catch (error) {
    console.error("❌ Error deleting file:", error.message);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

const subject_details = 'subject_details';
app.get("/subjects/:branch/:semester", async (req, res) => {
  const client = new MongoClient(mongoURI);
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(subject_details);

    const { branch, semester } = req.params;

    const result = await collection.findOne({}, {
      projection: { _id: 0, [`BTech.${branch}.${semester}`]: 1 }
    });

    console.log("Result:", JSON.stringify(result, null, 2));

    if (!result || !result.BTech || !result.BTech[branch] || !result.BTech[branch][semester]) {
      return res.status(404).json({ success: false, message: "No subjects found." });
    }

    let subjects = result.BTech[branch][semester];

    return res.json({ success: true, subjects });

  } catch (error) {
    console.error("Error fetching subjects:", error);
    res.status(500).json({ success: false, error: "Internal server error" });
  } finally {
    await client.close();
  }
});
const collectionName = "paper_details";

app.get("/questionpapers/:subject", async (req, res) => {
  const client = new MongoClient(mongoURI);
  try {
    let { subject } = req.params;
    
    
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    const papers = await collection.find({
      subject: { $regex: new RegExp(`^${subject}$`, "i") }
    }).toArray();

    if (papers.length === 0) {
      return res.json({ success: false, message: "❌ No question papers found." });
    }

    res.json({ success: true, subject, papers });
  } catch (error) {
    console.error("⚠ Error fetching papers:", error);
    res.status(500).json({ success: false, message: "Error retrieving data", error });
  }
});


// ✅ NEW: Update filename or subject
app.put("/update/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { newFilename, newSubject } = req.body;

    if (!newFilename && !newSubject) {
      return res.status(400).json({ success: false, message: "No update fields provided." });
    }

    const updateFields = {};
    if (newFilename) updateFields.filename = newFilename;
    if (newSubject) updateFields.subject = newSubject;

    const result = await FileModel.findByIdAndUpdate(id, updateFields, { new: true });

    if (!result) {
      return res.status(404).json({ success: false, message: "File not found." });
    }

    res.json({ success: true, message: "File updated successfully.", updatedFile: result });
  } catch (error) {
    console.error("❌ Error updating file:", error.message);
    res.status(500).json({ success: false, message: "Failed to update file." });
  }
});


// ... existing constants
const paperCollection = "paper_details";
app.get("/api/subjects", async (req, res) => {
  try {
    const db = mongoose.connection.useDb('synergic');
    
    const collection = db.collection("all_subjects");

    const subjects = await collection
      .find({})
      .sort({ name: 1 }) 
      .toArray();

    console.log(`✅ Success: Found ${subjects.length} subjects.`);

    if (!subjects || subjects.length === 0) {
      return res.status(404).json({ message: "no_subjects" });
    }

    res.json(subjects);
  } catch (error) {
    console.error("❌ Error fetching subjects:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});




// 1. Define the Nested Schema Structure
const savedSchema = new mongoose.Schema({
  user_id: { type: String, required: true, unique: true },
  saved_papers: [
    {
      collection_name: { type: String, required: true },
      papers: [{ type: String }] // Array of paper IDs (strings)
    }
  ]
}, { timestamps: true }); // Good practice to track when things were saved

// 2. Define the Model using the 'synergic' DB connection
const SavedModel = mongoose.connection
  .useDb("synergic")
  .model("saved_details", savedSchema, "saved_details");

module.exports = SavedModel;
// 3. The Save Route
app.post("/api/save-paper", async (req, res) => {
  try {
    const { user_id, collection_name, paper_id } = req.body;

    if (!user_id || !collection_name || !paper_id) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // 1. Try to update an existing collection within the user's document
    // $[elem] is a filtered positional operator that targets the specific collection
    const updatedUser = await SavedModel.findOneAndUpdate(
      { user_id: user_id, "saved_papers.collection_name": collection_name },
      { $addToSet: { "saved_papers.$[elem].papers": paper_id } },
      { 
        arrayFilters: [{ "elem.collection_name": collection_name }],
        new: true 
      }
    );

    // 2. If updatedUser is null, it means either the user or the collection doesn't exist
    if (!updatedUser) {
      const newUserDoc = await SavedModel.findOneAndUpdate(
        { user_id: user_id },
        { 
          $push: { 
            saved_papers: { collection_name: collection_name, papers: [paper_id] } 
          } 
        },
        { upsert: true, new: true }
      );
      
      return res.json({ success: true, message: "New collection/user created", data: newUserDoc });
    }

    res.json({ success: true, message: "Paper added to collection", data: updatedUser });

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.get("/api/saved-papers/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    // Find the document where user_id matches
    const userData = await SavedModel.findOne({ user_id: user_id });

    if (!userData) {
      return res.status(404).json({ 
        success: false, 
        message: "No saved papers found for this user." 
      });
    }

    res.json({
      success: true,
      data: userData.saved_papers
    });

  } catch (error) {
    console.error("❌ Error fetching papers:", error.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/api/unsave-paper", async (req, res) => {
  try {
    const { user_id, collection_name, paper_id } = req.body;

    if (!user_id || !collection_name || !paper_id) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    // $pull from the 'papers' array inside the specific collection object
    const updatedUser = await SavedModel.findOneAndUpdate(
      { 
        user_id: user_id, 
        "saved_papers.collection_name": collection_name 
      },
      { 
        $pull: { "saved_papers.$.papers": paper_id } 
      },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User or collection not found" });
    }

    res.json({ 
      success: true, 
      message: "Paper removed successfully", 
      data: updatedUser.saved_papers 
    });

  } catch (error) {
    console.error("❌ Error unsaving paper:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});



app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});

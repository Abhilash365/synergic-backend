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
app.use(cors());
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
const request_details = "request_details";

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
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { year, branch, semester, subject } = req.body;
    if (!year || !branch || !semester || !subject) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const fileMetadata = { name: req.file.originalname };
    const media = { mimeType: req.file.mimetype, body: fs.createReadStream(req.file.path) };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: "id",
    });

    if (!response.data.id) throw new Error("Failed to upload to Google Drive");
    fs.unlinkSync(req.file.path);

    const fileId = response.data.id;

    await drive.permissions.create({
      fileId: fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    const result = await drive.files.get({ fileId: fileId, fields: "webViewLink" });
    const fileLink = result.data.webViewLink;

    const newFile = new FileModel({
      filename: req.file.originalname,
      driveLink: fileLink,
      yearOfStudy: year,
      branch: branch,
      semester: semester,
      subject: subject,
    });

    await newFile.save();

    res.json({ success: true, fileId: fileId, link: fileLink });
  } catch (error) {
    console.error("❌ Upload error:", error.message);
    res.status(500).json({ error: "Failed to upload file" });
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

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
});
const express = require("express");
const { MongoClient } = require("mongodb");

const router = express.Router();
const client = new MongoClient("mongodb+srv://vamsipraneeth2004:praneeth-123@cluster0.bjjmx.mongodb.net/synergic?retryWrites=true&w=majority");
const { body, validationResult } = require('express-validator');
(async () => {
    await client.connect();
})();

const db = client.db("synergic");
const user_details = db.collection("user_details");

router.post("/createUser", [body('username').isLength({min:2}),
// password must be at least 5 chars long
body('password',"incorrect password").isLength({ min: 3 })], async (req, res) => {

 
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {


        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ success: false, message: "Username and password are required." });
        }

        const existingUser = await user_details.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "Username already taken." });
        }

    

        await user_details.insertOne({ username, password});

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Internal server error" });
    }
});



router.post("/loginUser",[body('username').isLength({min:5}),
    // password must be at least 5 chars long
    body('password',"incorrect password").isLength({ min: 5 })], async (req, res) => {
    
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
          return res.status(400).json({ errors: errors.array() });
        }
    
        try {
    
    
            const { username, password } = req.body;
    
            if (!username || !password) {
                return res.status(400).json({ success: false, message: "Username and password are required." });
            }
    
            const userData = await user_details.findOne({ username });
            if (!userData) {
                return res.status(400).json({ success: false, message: "Username not found" });
            }
           if(password!==userData.password){
            return res.status(400).json({ success: false, message: "password incorrect" });
           }
    
            res.json({ success: true });
        } catch (error) {
            console.error(error);
            res.status(500).json({ success: false, message: "Internal server error" });
        }
    });






module.exports = router;

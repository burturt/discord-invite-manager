var express  = require('express')
    , session  = require('express-session')
    , {body, validationResult} = require('express-validator')
    , passport = require('passport')
    , Strategy = require('passport-discord').Strategy
    , refresh = require('passport-oauth2-refresh')
    , app      = express()
    , { Sequelize, DataTypes } = require('sequelize')
    , fetch = require('node-fetch')
    , csrf = require('csurf')
    , SqliteStoreFactory = require("express-session-sqlite").default;

const bodyParser = require("body-parser");
const discord = require('./discord')
const sqlite3 = require("sqlite3");
const SqliteStore = SqliteStoreFactory(session);
require('dotenv').config();
var csrfProtection = csrf({ cookie: false })

const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: 'data/data.sqlite'
});

const User = sequelize.define('users', {
    // Model attributes are defined here
    accessToken: {
        type: DataTypes.STRING,
        allowNull: false
    },
    refreshToken: {
        type: DataTypes.STRING,
        allowNull: false
    },
    discordId: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    },
    linkCode: {
        type: DataTypes.STRING,
        allowNull: true
    },
    admin: {
        type: DataTypes.BOOLEAN,
        allowNull: false
    },
    discordUsername: {
        type: DataTypes.STRING,
        allowNull: true
    }
}, {
    // Other model options go here
});
sequelize.sync({ force: false })
    .then(() => {
        console.log(`Database & tables created!`);
    });

passport.serializeUser(function(user, done) {
    done(null, user);
});
passport.deserializeUser(function(obj, done) {
    done(null, obj);
});

var scopes = ['identify', 'guilds.join'];
var prompt = 'consent'

const strategy = new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'http://localhost:3000/callback',
    scope: scopes,
    prompt: prompt
}, function(accessToken, refreshToken, profile, done) {
    process.nextTick(async function () {

        let [user, created] = await User.findOrCreate({
            where: {discordId: profile.id},
            defaults: {
                discordId: profile.id,
                accessToken: accessToken,
                refreshToken: refreshToken,
                admin: false,
                discordUsername: `${profile.username}#${profile.discriminator}`,
                linkCode: 'default'
            }
        });
        user.update({accessToken: accessToken, refreshToken: refreshToken})
        console.log(refreshToken);

        return done(null, profile);
    });
});

passport.use(strategy);
refresh.use(strategy);

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SqliteStore({
        driver: sqlite3.Database,
        path: 'sessions.db',
        // Session TTL in milliseconds
        ttl: 3600000,
        // (optional) Adjusts the cleanup timer in milliseconds for deleting expired session rows.
        // Default is 5 minutes.
        cleanupInterval: 300000
    }),
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(bodyParser.raw());
app.set('view engine', 'pug')
app.use(passport.initialize());
app.use(passport.session());
app.use(csrfProtection);

app.get('/', passport.authenticate('discord', { scope: scopes, prompt: prompt }), function(req, res) {});
app.get('/callback',
    passport.authenticate('discord', { failureRedirect: '/' }), function(req, res) { res.redirect('/link') } // auth success
);
app.get('/logout', function(req, res) {
    req.logout();
    res.redirect('/');
});
app.get('/info', checkAuth, function(req, res) {
    //console.log(req.user)
    res.json(req.user);
});
app.get('/link', checkAuth, async function (req, res) {
    try {
        let user = await User.findOne({where: {discordId: req.user.id}});
        res.render('linking', {
            title: 'Linking',
            csrfToken: req.csrfToken(),
            currentLink: user.linkCode,
            admin: user.admin,
            error: req.query.invalid !== '1' ? '' : 'Error: invalid code. Code must be alphanumeric with dashes.'
        });
    } catch {
        res.render("An unexpected error occured. Try again.")
    }
})

app.post('/add', csrfProtection, body('code', 'invalid').matches('^[a-zA-Z0-9\-]+$'), checkAuth, async (req, res) => {

    var err = validationResult(req);
    if (!err.isEmpty()) {
        res.redirect("/link?invalid=1");
        return;
    }

    try {
        await sequelize.authenticate();
    } catch (error) {
        res.send('An unexpected error occurred. Please try again later');
        console.log(error);
    }
    try {
        let user = await User.findOne ({ where: { discordId: req.user.id } });
        await user.update({
            linkCode: req.body.code,
        });
        res.redirect(`/link`);

    } catch (error) {
        res.send(`An unexpected error occurred.`);
        console.log(error);
        return;
    }

});

app.get('/admin', checkAdmin, async (req, res) => {
    let errMsg;
    switch (req.query.invalid) {
        case '1':
            errMsg = 'Error: invalid code. Code must be alphanumeric with dashes.';
            break;
        case '2':
            errMsg = 'Error: discord IDs are 18 or 19 digit long numbers.';
            break;
        default:
            errorMsg = '';
    }
    res.render('admin', { title: 'Admin', csrfToken: req.csrfToken(), error: errMsg });
});

app.post('/admin/list', csrfProtection, body('code', 'invalid').matches('^[a-zA-Z0-9\-]+$'), checkAdmin, async(req, res) => {
    var err = validationResult(req);
    if (!err.isEmpty()) {
        res.redirect("/admin?invalid=1");
        return;
    }
    var list = await User.findAll( {where: {linkCode: req.body.code} });
    var stringList = [];
    for (const item of list) {
        try {
            const userInfo = await getUserInfo(item);
            stringList.push(`${userInfo.username}#${userInfo.discriminator}`);
        } catch (error) {
            console.log(error);
        }
    }
    res.render('admin-list', { title: 'User List', csrfToken: req.csrfToken(), code: req.body.code, users: stringList });


});

app.post('/admin/add', csrfProtection, body('discordId', 'invalid').matches('^[0-9]{18,19}$'),
    body('guildId', 'invalid').matches('^[0-9]{18,19}$'), checkAdmin, async(req, res) => {
    var err = validationResult(req);
    if (!err.isEmpty()) {
    res.redirect("/admin?invalid=2");
    return;
    }
    try {
        let user = await User.findOne({where: {discordId: req.body.discordId}});
        await getUserInfo(user);
        await discord.addUserToGuild(user, req.body.guildId);
        res.render('admin-add', {title: 'Manual add user', csrfToken: req.csrfToken(), output: 'Successfully added the user to the discord server if they weren\'t already in the server.'})
    } catch (error) {
        res.render('admin-add', {title: 'Manual add user', csrfToken: req.csrfToken(), output: 'An error occurred while trying to add the user to the discord server. Is the user ID and server Id correct and is the user authenticated and does the bot have permissions?'})
    }
});

app.post('/admin/massadd', csrfProtection, body('code', 'code').matches('^[a-zA-Z0-9\-]+$'),
    body('guildId', 'id').matches('^[0-9]{18,19}$'), checkAdmin, async(req, res) => {

    var err = validationResult(req);
    if (!err.isEmpty()) {
        console.log(err.array({onlyFirstError: true}));
        if (err.array({onlyFirstError: true})[0].msg === 'code') {
            res.redirect("/admin?invalid=1");
        } else {
            res.redirect("/admin?invalid=2");
        }
        return;
    }

    var list = await User.findAll( {where: {linkCode: req.body.code} });
    var stringList = [];
    for (const item of list) {
        try {
            const userInfo = await getUserInfo(item);
            await discord.addUserToGuild(item, req.body.guildId);
            stringList.push(`✅ ${userInfo.username}#${userInfo.discriminator}`);
        } catch (error) {
            stringList.push(`❌ ${item.discordUsername}`);
            console.log(error);
        }
    }

    res.render('admin-massadd', { title: 'Mass Add Results', csrfToken: req.csrfToken(), code: req.body.code, users: stringList });

    });
app.get('/admin/*', async(req, res) => {
    res.redirect('/admin');
});

async function getUserInfo(user) {
    let info;
    info = await fetch('https://discord.com/api/users/@me', {
        headers: {
            authorization: `Bearer ${user.accessToken}`,
        },
    });
    if (info.status != 200) {
        await refresh.requestNewAccessToken('discord', item.refreshToken, async function (err, accessToken, refreshToken) {
            if (err)
                return;

            await user.update({accessToken: accessToken}); // store this new one for our new requests!
            info = await fetch('https://discord.com/api/users/@me', {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                },
            });

        });
    }
    const infoFormatted = await info.json();
    if (infoFormatted !== null) {
        user.update({discordUsername: `${infoFormatted.username}#${infoFormatted.discriminator}`});
    }
    return infoFormatted;

};

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
};

async function checkAdmin(req, res, next) {
    if (!req.isAuthenticated()) res.redirect('/');
    let user = await User.findOne({where: {discordId: req.user.id}});
    if (user.admin) return next();
    res.redirect('/');
};

app.use(function (err, req, res, next) {
    if (err.code !== 'EBADCSRFTOKEN') return next(err)

    // handle CSRF token errors here
    res.status(403)
    res.send('403 Forbidden: For your protection, this request has been blocked. Please try again and make sure you only use forms on this website to submit changes.')
})

// start up the server
app.listen(3000, function () {
    console.log('Listening on http://localhost:3000');
});


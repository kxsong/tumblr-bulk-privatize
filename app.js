function checkLogin(req, res, next){
    if(!req.session.user){
        res.redirect('/');
    } else {
      next();
    }
}

var express = require('express');
var path = require('path');
var bodyParser = require('body-parser')
var favicon = require('serve-favicon');
var session = require('express-session')

var fs = require('fs');
var secrets = JSON.parse(fs.readFileSync('credentials.json'))

var passport = require('passport')
var util = require('util')
var TumblrStrategy = require('passport-tumblr').Strategy;
var tumblr = require('tumblr.js');
var tumblrclient; //to be initialized at login


var app = express();

app.use(bodyParser.urlencoded({ extended: false }))
app.use(passport.initialize());
app.use(passport.session());
app.use(session({
    secret: secrets.sessionsecret,
    resave: false,
    saveUninitialized: true
}));

// Passport serialization
passport.serializeUser(function (user, done) {
  done(null, user);
});

passport.deserializeUser(function (obj, done) {
  done(null, obj);
});

//Tumblr authentication
passport.use(new TumblrStrategy({
    consumerKey: secrets.TUMBLR_CONSUMER_KEY,
    consumerSecret: secrets.TUMBLR_SECRET_KEY,
    callbackURL: "/auth/tumblr/callback"
  },
  function (token, tokenSecret, profile, done) {
    process.nextTick(function () {      
      var userinfo = {
        "profile" : profile,
        "token" : token,
        "tokenSecret" : tokenSecret
      }
      tumblrclient = tumblr.createClient({
        consumer_key: secrets.TUMBLR_CONSUMER_KEY,
        consumer_secret: secrets.TUMBLR_SECRET_KEY,
        token: token,
        token_secret: tokenSecret
      });
      return done(null, userinfo);
    });
  }
));

app.get('/auth/tumblr',
  passport.authenticate('tumblr'));

app.get('/auth/tumblr/callback', 
  passport.authenticate('tumblr', { failureRedirect: '/login' }),
  function(req, res) {
    req.session.user = req.user
    res.redirect('/app');
  });

// Post-login
app.get('/app', checkLogin, function (req, res) {

    var tumblrjson = req.session.user.profile._json

    if(tumblrjson.meta.status != "200"){
        res.send("error: tumblr returned non-ok status code: " + json.meta.status)
        return;
    }
    
    console.log(JSON.stringify(tumblrjson.response.user.blogs, null, 4))
    res.render('app', {
        user: tumblrjson.response.user.name,
        blogs: tumblrjson.response.user.blogs,
    });
});


// main section
app.post('/run', checkLogin, function (req, res) {
  var MAX_RETRIES = 3
  var failedposts = [];
  var successcount = 0;
  var pendingcount = 0;
  var skipped = 0;
  var batchfailures = 0;
  var alreadyprivate = 0;
  var running = true;
  var offset = parseInt(req.param('offset'));
  var blog = req.param('blog');
  
  //privatizes a single post
  var privatizepost = function(post, retrycount){
  tumblrclient.edit(
    blog,
    {id: post.id, state: "private"},
    function(err,rsp){
      if(err){
        if (retrycount >= MAX_RETRIES) {
          rsp.write("failed to privatize post " + post.url + " after " + MAX_RETRIES + " times: error " + err + "<br>")
          failedposts.push(post.id)
        } else {
          setTimeout(function(){privatizepost(blog, post, retrycount+1)}, 2000);
        }
      }
      if(rsp){
        successcount++;
        console.log("privatized " + successcount + " posts")
      }
    }
  );
}

//iterates through 20 posts at a time, skipping $offset private posts
//and privatizing the rest
var privatizebatch = function(startidx, retrycount){
  tumblrclient.posts(
    blog,
    {offset:startidx, limit:20},
    function(err,rsp){
      var delay = 1000;
      //console.log("err: \n" + JSON.stringify(err, null, 4))
      //console.log("rsp: \n" + JSON.stringify(rsp, null, 4))
      if(err){
        console.log(err)
        if(retrycount + 1 > MAX_RETRIES){
          rsp.write("failed to retrieve posts after " + MAX_RETRIES + " tries: error " + err + "<br>");
          batchfailures++;
        } else{
          console.log("batch error at " + startidx + ", trying again");
          setTimeout(function(){privatizebatch(startidx, retrycount + 1)}, 5000);
        }
      }
      for(var idx in rsp.posts){
        var post = rsp.posts[idx];
        if(post.state != "private"){
          console.log("found public post " + post.id)
          if(skipped < offset){
            skipped++;
          } else{
            pendingcount++;
            privatizepost(post, 0);
            delay += 200;
          }
        } else {
          console.log("ignoring private post " + post.id)
          alreadyprivate++;
        }
      }
      if(rsp.posts.length > 0){
        setTimeout(function(){privatizebatch(startidx+20)}, delay);   
      } else {
        console.log("reached final batch, running=false")
        running = false;
      }
    });
}

// ugh
function busywait(){
  var donecount = successcount + failedposts.length;
  if(running || pendingcount < donecount){
    res.write("skipped " + skipped + " out of " + offset + " public posts. ")
    res.write("found " + pendingcount + " unskipped posts, privatized " + successcount + " of them. ")
    res.write(alreadyprivate + " already private posts skipped.<br>")
    setTimeout(busywait, 2000);
  } else complete();
}

function complete(){
  res.write("<h2>Complete. privatized " + successcount + " posts.</h2>");
  if(failedposts.length > 0){
    res.write(failedposts.length + " posts failed. See log.");
  }
  if(batchfailures > 0){
    res.write(batchfailures + "batch failures");
  }
  res.write("<h3><a href=app>return</a></h3>");
  res.write("note: post count/pagination does not immediately update."+
    "You can confirm that the app worked through your dashboard:<br>" +
    "<br><img src='images/private_post.png'></img>");

  res.end();
  //res.end(JSON.stringify(req.session.user.profile._json));
}

  if(isNaN(offset) || offset < 0 || !blog){
      var err = new Error('Incorrect parameters. Please select a blog and an index >=0');
      err.status = 400;
      res.render('error', {
          message: err.message,
          error: {}
      });
      return;
  }

  privatizebatch(0, 0);
  res.setHeader('Connection', 'Transfer-Encoding');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.write("<h2>Running...</h2>");
  busywait();

})



app.get('/run', checkLogin, function (req, res) {
    res.redirect('/app');
})

app.get('/', function (req, res) {
  res.render('index')
});

app.get('/logout', function (req, res){
  req.logout();
  res.redirect('/');
});


// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// uncomment after placing your favicon in /public
//app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(express.static(path.join(__dirname, 'public')));


// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
} else {
    // production error handler
    // no stacktraces leaked to user
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: {}
        });
    });
}

module.exports = app;
/**
 * Created by Stefano Cappa on 01/08/15.
 */

/**
 The MIT License (MIT)

 Copyright (c) 2014 Marijn Haverbeke
 Copyright (c) 2015 Stefano Cappa

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 */

//running this program definied so far will get you a server running on port 8000, which servers files from the
//public subdirectory alongside a talk-managing interface under the /talks URL.

var http = require("http");
var Router = require("./router");

//ecstatic is a static file server from npm
//ecstatic module exports a function that can be called with a config object to produce a request handler function.
//createServer to create a server that serves only files.
var ecstatic = require("ecstatic");

//We use the root option to tell the serve where it should look for file (in my case in ./public)
var fileServer = ecstatic({root: "./public"});

var router = new Router();

//The handler function accepts request and response parameters and can be passed directly to
http.createServer(function (request, response) {
    if (!router.resolve(request, response))
        fileServer(request, response);
}).listen(8000);

//the respond and respondJSON helper functions are used throughout the server
//code to send off responses with a single function call
function respond(response, status, data, type) {
    response.writeHead(status, {
        "Content-Type": type || "text/plain"
    });
    response.end(data);
}

function respondJSON(response, status, data) {
    respond(response, status, JSON.stringify(data),
        "application/json");
}


//The server keeps the talks that have benn proposed in an object called talks, whose property
//names are the talks titles. These will be exposed as HTTP resources under /talks/[title], so
var talks = Object.create(null);

//we need to add handlers to our router that implement the various methods that clients
//can use to work with them.
router.add("GET", /^\/talks\/([^\/]+)$/,
    function (request, response, title) {
        //if the title is in talks respond with 200
        if (title in talks)
            respondJSON(response, 200, talks[title]);
        else
            //if the title isn't in talks respond with an error 404 and a message
            respond(response, 404, "No talk '" + title + "' found");
    });

router.add("DELETE", /^\/talks\/([^\/]+)$/,
    function (request, response, title) {
        if (title in talks) {
            //remove a talk by title
            delete talks[title];
            //notifies waiting long-polling requests about the change
            registerChange(title);
        }
        respond(response, 204, null);
    });

//To retrieve the content of JSON-encoded request bodies, we define a
//function called readStreamAsJSON, which reads all content from a
// stream, parses it as JSON and then calls a callback function.
function readStreamAsJSON(stream, callback) {
    var data = "";
    stream.on("data", function (chunk) {
        data += chunk;
    });
    stream.on("end", function () {
        var result, error;
        try {
            result = JSON.parse(data);
        }
        catch (e) {
            error = e;
        }
        callback(error, result);
    });
    stream.on("error", function (error) {
        callback(error);
    });
}


//one handler that needs to read JSON responses is the PUT handler, which is used to create new talks.
//it has to check whether the data it was given has presenter and summary properties, which are strings.
//Any data coming from outside the system migth be nonsense, and we don't want to corrupt our internal data model.
//If the data looks valid, the handler stores an object that represents the new talk in the talks object, possibly
//overwriting an existing talk with this title, and again calls registerChange.
router.add("PUT", /^\/talks\/([^\/]+)$/,
    function (request, response, title) {
        readStreamAsJSON(request, function (error, talk) {
            if (error) {
                respond(response, 400, error.toString());
            } else if (!talk ||
                typeof talk.presenter != "string" ||
                typeof talk.summary != "string") {
                respond(response, 400, "Bad talk data");
            } else {
                talks[title] = {
                    title: title,
                    presenter: talk.presenter,
                    summary: talk.summary,
                    comments: []
                };
                registerChange(title);
                respond(response, 204, null);
            }
        });
    });

//Adding a comment to a talk works similarly. We use readStreamAsJSON to get the content of the request,
//validate the resulting data, and store it as a comment when it looks valid.
router.add("POST", /^\/talks\/([^\/]+)\/comments$/,
    function (request, response, title) {
        readStreamAsJSON(request, function (error, comment) {
            if (error) {
                respond(response, 400, error.toString());
            } else if (!comment ||
                typeof comment.author != "string" ||
                typeof comment.message != "string") {
                respond(response, 400, "Bad comment data");
            } else if (title in talks) {
                talks[title].comments.push(comment);
                registerChange(title);
                respond(response, 204, null);
            } else {
                respond(response, 404, "No talk '" + title + "' found");
            }
        });
    });


//**************************************
//******LONG-POLLING SUPPORT************
//**************************************
//When a GET request comes in for /talks, it can be either a simple request for all
//talks or a request for updates, with a changeSince parameter.
//We first define a small helper function that attaches the serverTime field to such responses.
function sendTalks(talks, response) {
    respondJSON(response, 200, {
        serverTime: Date.now(),
        talks: talks
    });
}

//the handler itself needs to look at the query parameters in the request's URL to see whether a changeSince parameter is given.
router.add("GET", /^\/talks$/, function (request, response) {
    //if you set true to the parse method of url module, it will also parse the query part of a URL.
    //the object it returns will have a query property, which holds another object that maps parameter names to values.
    var query = require("url").parse(request.url, true).query;
    if (query.changesSince == null) {
        var list = [];
        for (var title in talks)
            list.push(talks[title]);
        sendTalks(list, response);
    } else {
        var since = Number(query.changesSince);
        if (isNaN(since)) {
            respond(response, 400, "Invalid parameter");
        } else {
            //when the changeSince parameter is missing, the handler simply builds up a list of all talks and returns that.
            //Otherwise, the changeSince parameter first has to be checked to make sure that it is a valid number.
            //The getChangedTalks function returns an array of changed talks since a given point in time.
            //if it returns an empty array, the server does not yet have anything to send back to the client, so it stores
            //the response object to be responded to at a later time.
            var changed = getChangedTalks(since);
            if (changed.length > 0)
                sendTalks(changed, response);
            else
                waitForChanges(since, response);
        }
    }
});

var waiting = [];

function waitForChanges(since, response) {
    var waiter = {since: since, response: response};
    waiting.push(waiter);
    setTimeout(function () {
        var found = waiting.indexOf(waiter);
        if (found > -1) {
            //the splice method is used to cut a piece out of an array. You give it an index and a number of elements,
            //and it mutuates the array, removing that many elements after the given index.
            //In this case we remove a single element, the object that tracks the waiting response, those index we
            //found by calling indexOf. If you pass additional arguments to splice, their values will be inserted
            // into the array at the given position, replacing the removed elements.
            //When a response object is stored in the waiting array, a timeout is immediately set. After 90 seconds, this
            //timeout sees whether the request is still waiting and, if it is, send an empty response and removes it from the waiting array.
            //To be able to find exactly those talks that heve been changed since a given point in time, we need to
            //keep track of the history of changes. Registering a change with registerChange will remember that change, along with
            // the current time, in an array called changes.
            waiting.splice(found, 1);
            sendTalks([], response);
        }
    }, 90 * 1000);
}

var changes = [];

//when a change occurs, that mean there is new data, so all waiting request can be responded to immediately.
function registerChange(title) {
    changes.push({title: title, time: Date.now()});
    waiting.forEach(function (waiter) {
        sendTalks(getChangedTalks(waiter.since), waiter.response);
    });
    waiting = [];
}


//Uses the changes array to build up an array of changed talks, including objects with a deleted property for talks that
//no longer exist. When building that array, getChangedTalks has to ensure that id doesn't include the same talk twice
//since there might have been multiple changes to a talk since the given time.
function getChangedTalks(since) {
    var found = [];

    function alreadySeen(title) {
        return found.some(function (f) {
            return f.title == title;
        });
    }

    for (var i = changes.length - 1; i >= 0; i--) {
        var change = changes[i];
        if (change.time <= since)
            break;
        else if (alreadySeen(change.title))
            continue;
        else if (change.title in talks)
            found.push(talks[change.title]);
        else
            found.push({title: change.title, deleted: true});
    }
    return found;
}



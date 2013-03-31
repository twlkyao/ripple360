#!/usr/bin/env node

/*
 * Not Another Satoshi Dice (NASD)
 * 
 * Configure this file for use with your "registered" BTC Village credentials.
 *
 * For more information, visit https://www.btcvillage.nl/developers
 *
 */

var WebSocket 	= require('ws');
var crypto 		= require('crypto');
var winston 	= require('winston');
var colors		= require('colors');

var config 		= require('./config')

var RIPPLE_SERVER 		= 'wss://s1.ripple.com:51233';
// TODO: add support for multiple addresses
//		 e.g. game odds can be set to a specific address
//		 and multiple games can be hosted on the same server
//
// 		 should probably write into a class to support instance variables
var RIPPLE_ADDRESS 		= config.address;		// game address
var RIPPLE_ADDRESS_KEY 	= config.key;			// secret key
var RIPPLE_SINGLE		= 1000000;				// value of a single ripple

// venue settings
var VENUE_APIKEY 			= "RIPPLE360-DEMO";	// TODO: will replace address array
var VENUE_PORT 				= 8003;				// front-end port (e.g. http://localhost:8000)
var VENUE_WIN_THRESHOLD		= 32768;			// TODO: localize to individual game engines
var VENUE_WIN_PAYOUT		= 0.9801;			// 98.01% payout percentage (house edge is 1.99%)
var DEBUG 					= true;

// TODO: retreive from persistent storage
// 		 this value is shared by ALL venues
// 		 and reset each day at 00:00 UTC
var VENUES_SECRET			= '123456';

// setup SSL options
//var options = {
//	key 	: fs.readFileSync(''),
//	cert 	: fs.readFileSync(''),
//	ca 		: [ fs.readFileSync('') ]
//};

// setup Express with IO Server
var express 	= require('express'),
	app 		= express(),
//	server 		= require('https').createServer(options, app),
	server 		= require('http').createServer(app),
	ioserver 	= require('socket.io').listen(server);

// set location for views (html)
app.use(express.static(__dirname + '/views'));

// start listening
server.listen(VENUE_PORT);

// logging configuration
var loggerConfig = {
	levels: {
		error: -1,
		info: 0,
		debug: 1
	},
	colors: {
		error: 'red',
		info: 'blue',
		debug: 'yellow'
	}
};

// create logger
var logger = new (winston.Logger)(
	{
		transports: [
			new (winston.transports.Console)({ colorize: 'true'}),
			new (winston.transports.File)({ filename: 'logs/2013.03.23' })
		]
	},
	{ levels: loggerConfig.levels }
);

// add logger colors
winston.addColors(loggerConfig.colors);

// connect to RIPPLE socket server
var ws = new WebSocket(RIPPLE_SERVER);

ws.on('open', function() {
	info('Connected to ' + 'RIPPLED'.bold.blue + ' successfully...');

	var msg = {
		"command"	: "subscribe",
		"accounts"	: [ RIPPLE_ADDRESS ]
	}

	// send subscription message
	ws.send(JSON.stringify(msg));
});

ws.on('message', function(message) {
	// parse the server's response
	var data = parseResponse(message);

	if (data.validated && data.account != RIPPLE_ADDRESS) {
		logSpacer();	// log spacer

		debug('Player Account: ' 	+ data.account);
		debug('Tx Hash: ' 			+ data.hash);
		debug('Bet Amount: ' 		+ parseInt(data.amount / RIPPLE_SINGLE));
		debug('Our Bank Roll: ' 	+ parseInt(data.bankroll / RIPPLE_SINGLE) + ' XRP');

		// run the Hi-Lo game
		runHiLo(data);
	} else if (data.result) {
		logSpacer();	// log spacer

		debug(data.message);
	} else {
		// TODO: we should provide confirmation that the payment
		// 		 was sent, received and processed successfully
//		logSpacer();	// log spacer
//		debug(message);
	}
});

/**
 * Simple 50/50 coin flip game.
 *
 * If user wins, the payout is calclated based 
 * on the venue's Win Percentage.
 */
function runHiLo(data) {
	info('STARTING Hi-Lo Game');

	var gameType 	= 16;		// 16-bit gameplay
	var payout 		= 0;

	// set to 20% of total bankroll
	var betLimit = parseInt(data.bankroll / 5);
	debug('Bet Limit: ' + betLimit + ' (' + parseInt(betLimit / RIPPLE_SINGLE) + ' XRP)');

	// calculate the fairplay point
	var point = calcFairplay(data, gameType);

	// calculate win/loss payout
	if (data.amount > betLimit) {
		info('WARNING!!!'.bold.red + ' Someone\'s trying to bankrupt us -- don\'t let it happen');

		// return their bet
		payout = data.amount;
	} else if (point < VENUE_WIN_THRESHOLD) {
		// this is a win -- send back winnings
		info('WINNER!'.bold.green)

		// calculate payout amount based on house edge ratio
		payout = parseInt(data.amount * VENUE_WIN_PAYOUT) + data.amount;
	} else {
		// this is a loss -- send back dust
		info('LOSER.'.bold.yellow)
		payout = 100;
	}

	info('Payout: ' + payout);

	// construct the payment message
	// TODO: for security reasons, its best to sign the transaction
	// 		 BEFORE sending it off to the ripple daemon
	//		 in order to protect the address' secret key
	msg = {
		'command' : 'submit',
		'tx_json' : {
			'TransactionType' : 'Payment',
			'Account'         : RIPPLE_ADDRESS,
			'Destination'     : data.account,
			'Amount'          : {
				'currency' : 'XRP',
				'value'    : payout,
				'issuer'   : RIPPLE_ADDRESS,
			}
		},
		'secret'  : RIPPLE_ADDRESS_KEY,
	}

	// send the payment transaction
	debug(JSON.stringify(msg));
	ws.send(JSON.stringify(msg));
}

/**
 * Calculate the hash for proper fairplay rules
 */
function calcFairplay(data, gameType) {
	info('Calculating Fairplay for ' + gameType + '-bit Game...');

	// init hmac 256
	var hmac = crypto.createHmac('sha256', VENUES_SECRET);

	// update with txid hash
	var hmacHash = hmac.update(data.hash).digest('hex');
	debug('hmacHash: ' + hmacHash.toString().toUpperCase());

	// calculate the number of bytes in the game
	// gameType / 4 = numChars
	// e.g. 32-bit game / 4 = 8 chars
	var numChars = parseInt(gameType / 4);

	// slice the number of bytes needed
	var hashBytes = hmacHash.slice(0, numChars);
	debug('hashBytes: ' + hashBytes.toString().toUpperCase());

	// calculate the int value from hex slice
	var hashInt	= parseInt(hashBytes, 16);
	debug('hashInt: ' + hashInt);

	return hashInt;
}

/**
 * Retrieve all of the important fields,
 * necessary for the game processing engines.
 * (based on a "subscribed" address)
 */
function parseResponse(message, subAddr) {
	var json 	= JSON.parse(message);
	var data 	= {};

	if (json.type == "transaction") {
		data.status 	= json.status;
		data.validated 	= json.validated;

		data.account 	= json.transaction.Account;
		data.amount 	= parseInt(json.transaction.Amount);
		data.fee 		= parseInt(json.transaction.Fee);
		data.date 		= json.transaction.date;
		data.hash 		= json.transaction.hash;

		// we need the server's bankroll
		data.bankroll 	= getBankroll(json);
	} else if (json.type == "response" && json.result.engine_result) {
		data.result 	= json.result.engine_result;
		data.message	= json.result.engine_result_message;
	}

	return data;
}

/**
 * Parse through affected transaction to find
 * a matching "subscribed" address, then retrieve the balance.
 */
function getBankroll(json) {
	var bankroll 	= 0;
	var destination = json.transaction.Destination;

	// get the affected nodes from meta
	var affected = json.meta.AffectedNodes;

	// iterate through all affected transactions
	affected.forEach(function (transaction) {
		// check for our subscribed address
		if (transaction.ModifiedNode.FinalFields.Account == destination) {
			// convert balance to an integer
			// TODO: will an integer be LARGE enough???
			// 		 should probably use BigInteger library
			bankroll = parseInt(transaction.ModifiedNode.FinalFields.Balance);
		}
	});

	return bankroll;
}

// setup logger helpers
function error(message) {
	logger.error(message);
}

function info(message) {
	logger.info(message);
}

function debug(message) {
	if (DEBUG) logger.debug(message);
}

function logSpacer() {
	console.log();
	console.log('------------------------------------------------------------');
	console.log();

}
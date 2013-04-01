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
var fs 			= require('fs');
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
var RIPPLE_SINGLE		= 1000000;				// quantity of "drops" in a single ripple

// venue settings
var VENUE_APIKEY 			= 'RIPPLE360-DEMO';	// TODO: will replace address array
var VENUE_PORT 				= 8003;				// front-end port (e.g. http://localhost:8000)
var VENUE_WIN_THRESHOLD		= 32768;			// TODO: localize to individual game engines
var VENUE_WIN_PAYOUT		= 0.9801;			// 98.01% payout percentage (house edge is 1.99%)

// bankroll management
var BANKROLL_MAX 			= 200000;			// maximum bankroll to trigger cashout
var BANKROLL_CASHOUT_VALUE 	= 100000;			// quantity of XRP to cashout
var BANKROLL_CASHOUT_ADDR 	= '';				// address to deliver cashout

// debugging messages
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

// initialize web socket instance
this.ws = null;

// retreive meta data
var meta = readMeta(function (meta) {
	self = this;

	// retreive current ledger index
	var curLedgerIdx = "n/a";

	info('Current Ledger Index: '.bold.cyan + curLedgerIdx);
	info('Last Ledger Index:    '.bold.cyan + meta.ledger);
	info('Last Tx Hash:         '.bold.cyan + meta.hash);
	info('Last Timesatmp:       '.bold.cyan + meta.timestamp);

	console.log();		// empty spacer

	// TODO: add support for server resume
	//		 we will need to retrieve the most recent
	// 		 ledger index and compare to meta data
	//
	//		 process all PENDING transaction BEFORE
	// 		 we send subscribe request to rippled
	//
	// 		 WARNING!!! We currently re-process the last
	// 		 ledger to avoid missing any transactions
	// 		 we MUST prevent from double payouts

	// connect to RIPPLED socket server
	this.ws = new WebSocket(RIPPLE_SERVER);

	this.ws.on('open', function() {
		info('Connected to ' + 'RIPPLED'.bold.blue + ' successfully...');

		// account information
		var msg = {
			"command" 	: "account_info",
			"account" 	: RIPPLE_ADDRESS
		}

//		self.ws.send(JSON.stringify(msg));

		// transaction history (from last meta checkpoint)
		var msg = {
			"command" 			: "account_tx", 
			"account" 			: RIPPLE_ADDRESS,
			"ledger_index_min" 	: meta.ledger
		}

		self.ws.send(JSON.stringify(msg));
	});

	this.ws.on('message', function(message) {
		// parse the server's response
		var data = parseResponse(message);

		if (data.validated && data.account != RIPPLE_ADDRESS) {
			logSpacer();	// log spacer

			info('Player Account:    '.bold + data.account);
			info('Bet Amount:        '.bold + parseInt(data.amount / RIPPLE_SINGLE));
			info('Our Bank Roll:     '.bold + parseInt(data.bankroll / RIPPLE_SINGLE) + ' XRP');

			debug('Ledger Index:     '.bold + data.ledger);
			debug('Transaction Hash: '.bold + data.hash);

			// do we have a destination tag
			if (data.tag)
				debug('Destination Tag:  '.bold + data.tag);

			// perform specific actions based on Destination Tag
			// e.g. 777 = refill / donate transaction (DO NOT RUN GAMES)
			if (data.tag && data.tag == 777) {
				logSpacer();	// log spacer

				info('Performing refill / donation to account...'.bold.red);
			} else {
				// run the Coin Flip game
				runCoinFlip(data);
			}
		} else if (data.txs) {
			logSpacer();	// log spacer

			debug(JSON.stringify(data.txs));

			/*
			 * process the pending transactions since last ledger index
			 */

			var numTxs = data.txs.length;

			info('There are '.bold.red + numTxs.toString().bold + 
				' transactions waiting to be processed.'.bold.red);
			
			console.log();		// empty spacer

			// run pending Coin Flip games
			for (var i = 0; i < numTxs; i++) {
				info('Player Account:    '.bold + data.txs[i].account);
				info('Bet Amount:        '.bold + parseInt(data.txs[i].amount / RIPPLE_SINGLE));
				info('Our Bank Roll:     '.bold + parseInt(data.txs[i].bankroll / RIPPLE_SINGLE) + ' XRP');

				debug('Ledger Index:     '.bold + data.txs[i].ledger);
				debug('Transaction Hash: '.bold + data.txs[i].hash);

				// do we have a destination tag
				// TODO: detect tag and perform specific actions
				// 		 e.g. 777 = refill transaction (DO NOT RUN GAMES)
				if (data.txs[i].tag)
					debug('Destination Tag:  '.bold + data.txs[i].tag);

				// perform specific actions based on Destination Tag
				// e.g. 777 = refill / donate transaction (DO NOT RUN GAMES)
				if (data.tag && data.tag == 777) {
					info('Performing refill / donation to account...'.bold.blue);
				} else {
					// run the Coin Flip game
					runCoinFlip(data.txs[i]);
				}
			}

			/*
			 * subscribe to address and start processing
			 * live transactions
			 */
			var msg = {
				"command"	: "subscribe",
				"accounts"	: [ RIPPLE_ADDRESS ]
			}

			self.ws.send(JSON.stringify(msg));

			info('Requesting LIVE transactions...'.bold.blue);
		} else if (data.result) {
			if (DEBUG)
				logSpacer();	// log spacer

			debug(data.message);
		} else {
			if (DEBUG)
				logSpacer();	// log spacer

			// TODO: we should provide confirmation that the payment
			// 		 was sent, received and processed successfully
			//
			//		 should also writeMeta when a subscribed
			// 		 tx is included in a closed ledger
			debug(message);
		}
	});
});


/**
 * Simple 50/50 coin flip game.
 *
 * If user wins, the payout is calclated based 
 * on the venue's Win Percentage.
 */
function runCoinFlip(data) {
	info('Starting Coin Flip Game'.bold.blue);

	var gameType 	= 16;		// 16-bit gameplay
	var payout 		= 0;

	// set to 20% of total bankroll
	var betLimit = parseInt(data.bankroll / 5);
	debug('Bet Limit: '.bold + betLimit + ' (~' + parseInt(betLimit / RIPPLE_SINGLE) + ' XRP)');

	// calculate the fairplay point
	var point = fairplayPoint(data, gameType);

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
		info('LOSER'.bold.yellow)
		payout = 100;
	}

	info('Payout: '.bold.blue + payout + ' (~' + parseInt(payout / RIPPLE_SINGLE) + ' XRP)');

	// construct the payment message
	// TODO: for security reasons, its best to sign the transaction
	// 		 BEFORE sending it off to the ripple daemon
	//		 in order to protect the address' secret key
	var msg = {
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
	this.ws.send(JSON.stringify(msg));

	// update meta data
	writeMeta(data);

	logSpacer();	// log spacer
}

/**
 * Calculate the point value based on proper fairplay rules
 */
function fairplayPoint(data, gameType) {
	info('Calculating Fairplay for '.bold.blue + 
		gameType.toString().bold + '-bit'.bold + 
		' Game...'.bold.blue);

	// init hmac 256
	var hmac = crypto.createHmac('sha256', VENUES_SECRET);

	// update with txid hash
	var hmacHash = hmac.update(data.hash).digest('hex');
	debug('hmacHash:  '.bold + hmacHash.toString().toUpperCase());

	// calculate the number of bytes in the game
	// gameType / 4 = numChars
	// e.g. 32-bit game / 4 = 8 chars
	var numChars = parseInt(gameType / 4);

	// slice the number of bytes needed
	var hashBytes = hmacHash.slice(0, numChars);
	debug('hashBytes: '.bold + hashBytes.toString().toUpperCase());

	// calculate the int value from hex slice
	var hashInt	= parseInt(hashBytes, 16);
	debug('hashInt:   '.bold + hashInt);

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
		data.validated 	= json.validated;
		data.ledger 	= json.ledger_index

		data.account 	= json.transaction.Account;
		data.amount 	= parseInt(json.transaction.Amount);
		data.fee 		= parseInt(json.transaction.Fee);
		data.date 		= json.transaction.date;
		data.hash 		= json.transaction.hash;

		// check for destination tag
		if (json.transaction.DestinationTag)
			data.tag 	= json.transaction.DestinationTag;

		// we need the server's bankroll
		data.bankroll 	= getBankroll(json);
	} else if (json.type == "response" && json.result.engine_result) {
		data.result 	= json.result.engine_result;
		data.message	= json.result.engine_result_message;
	} else if (json.type == "response" && json.result.transactions) {
		// initialize tx index
		var index = 0;

		// initialize txs array
		data.txs  = [];

		json.result.transactions.forEach(function (json) {
			// initialize txs object
			data.txs[index] 			= {};

			data.txs[index].validated 	= json.validated;
			data.txs[index].ledger 		= json.tx.inLedger

			data.txs[index].account 	= json.tx.Account;
			data.txs[index].amount 		= parseInt(json.tx.Amount);
			data.txs[index].fee 		= parseInt(json.tx.Fee);
			data.txs[index].date 		= json.tx.date;
			data.txs[index].hash 		= json.tx.hash;

			// check for destination tag
			if (json.tx.DestinationTag)
				data.txs[index].tag 	= json.tx.DestinationTag;

			// we need the server's bankroll
			// TODO: this needs to pull from the ACTIVE account state
			// 		 historical data could result in substantial losses
			// 		 for now, keep this number low
			data.txs[index].bankroll 	= (5000 * RIPPLE_SINGLE);	// FIX ASAP

			// increment the index
			index++;
		});
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

// read meta data from file
function readMeta(callback) {
	// initialize server's persistent data
	fs.readFile('meta.json', 'utf8', function (err, data) {
		if (err) {
			error(JSON.stringify(err));

			if (err.code == "ENOENT") {
				// write default data to meta storage
				return writeMeta();
			}

			return;
		}

		// return data
		callback(JSON.parse(data));
	});
}

// write meta data to file
function writeMeta(data) {
	if (typeof data === 'undefined') {
		var ledger 	= 0;
		var hash 	= "";
	} else {
		var ledger 	= data.ledger;
		var hash 	= data.hash;
	}

	// linux timestamp
	var timesatmp = Math.round((new Date()).getTime() / 1000);

	// default meta data
	var meta = {
		'ledger'	: ledger,
		'hash'		: hash,
		'timestamp'	: timesatmp
	}

	// write the new data
	fs.writeFile('meta.json', JSON.stringify(meta), function (err) {
		if (err) {
			error(err.message);

			return;
		}

		info('meta.json'.bold.blue + ' saved successfully...');
	});

	// return meta data
	return meta;
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
	console.log('======================================================='.grey);
	console.log();
}

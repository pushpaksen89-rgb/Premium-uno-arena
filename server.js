const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('public'));

let players = []; 
let deck = [];
let discardPile = [];
let currentTurnIndex = 0;
let gameDirection = 1; 
let gameStarted = false;
let winnersList = []; 
let activeWildColor = null; 

function createDeck() {
    const colors = ['Red', 'Blue', 'Yellow', 'Green'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', 'Draw2'];
    let newDeck = [];

    for (let color of colors) {
        for (let value of values) {
            newDeck.push({ color, value });
            if (value !== '0') newDeck.push({ color, value });
        }
    }
    for (let i = 0; i < 4; i++) {
        newDeck.push({ color: 'Wild', value: 'Wild' });
        newDeck.push({ color: 'Wild', value: 'Draw4' });
    }
    return shuffle(newDeck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function advanceTurn() {
    if (players.length === 0) return;
    let safetyCounter = 0;
    do {
        currentTurnIndex = (currentTurnIndex + gameDirection + players.length) % players.length;
        safetyCounter++;
    } while (players[currentTurnIndex].finished && safetyCounter <= players.length);
}

io.on('connection', (socket) => {
    // --- VOICE CHAT SIGNALING (WebRTC Peer-to-Peer Linker) ---
    socket.on('voice-join', () => {
        socket.broadcast.emit('voice-peer-joined', socket.id);
    });
    socket.on('voice-signal', (data) => {
        io.to(data.to).emit('voice-signal', { from: socket.id, signal: data.signal });
    });

    socket.on('joinGame', (data) => {
        if (gameStarted) {
            socket.emit('errorAlert', 'Game has already started!');
            return;
        }
        
        players.push({
            id: socket.id,
            name: data.username || `Guest_${socket.id.substring(0,4)}`,
            hand: [],
            isAdmin: data.password === 'ADMIN_GOD_MODE',
            finished: false,
            saidUno: false
        });
        io.emit('updatePlayers', players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length, isAdmin: p.isAdmin })));
    });

    socket.on('startGameSignal', () => {
        if (players.length < 2) {
            socket.emit('errorAlert', 'You need at least 2 players!');
            return;
        }
        gameStarted = true;
        winnersList = [];
        activeWildColor = null;
        deck = createDeck();
        
        players.forEach(player => {
            player.hand = deck.splice(0, 7);
            player.finished = false;
            player.saidUno = false;
        });

        let startingCard = deck.pop();
        while (startingCard.color === 'Wild') {
            deck.unshift(startingCard);
            startingCard = deck.pop();
        }
        discardPile.push(startingCard);
        currentTurnIndex = 0;
        gameDirection = 1;

        updateEntireClientState();
    });

    socket.on('playCardRequest', (data) => {
        const player = players.find(p => p.id === socket.id);
        if (!player || player.finished) return;

        if (players[currentTurnIndex].id !== socket.id) {
            socket.emit('errorAlert', "Wait for your turn!");
            return;
        }

        const cardToPlay = player.hand[data.index];
        const topCard = discardPile[discardPile.length - 1];

        // Match color check (takes chosen active Wild Color into account too!)
        const matchingColor = activeWildColor || topCard.color;
        const isValidMove = 
            cardToPlay.color === 'Wild' || 
            cardToPlay.color === matchingColor || 
            cardToPlay.value === topCard.value;

        if (!isValidMove) {
            socket.emit('errorAlert', `Invalid Card! Must match ${matchingColor} or ${topCard.value}.`);
            return;
        }

        // Check if player forgot to call UNO on previous turn state when dropping to 1 card
        if (player.hand.length === 2 && !player.saidUno) {
            socket.emit('errorAlert', "Penalty! You didn't press 'UNO!' before dropping to 1 card. Drawing 2 cards!");
            player.hand.push(...deck.splice(0, 2));
            advanceTurn();
            updateEntireClientState();
            return;
        }

        player.hand.splice(data.index, 1);
        discardPile.push(cardToPlay);
        
        // Reset wild color tracker and UNO flags for next rounds
        activeWildColor = cardToPlay.color === 'Wild' ? data.chosenColor : null;
        if (player.hand.length > 1) player.saidUno = false; 

        let turnSteps = 1;
        if (cardToPlay.value === 'Skip') advanceTurn(); 
        else if (cardToPlay.value === 'Reverse') {
            gameDirection *= -1;
            if (players.length === 2) advanceTurn(); 
        } else if (cardToPlay.value === 'Draw2') {
            advanceTurn();
            players[currentTurnIndex].hand.push(...deck.splice(0, 2));
        } else if (cardToPlay.value === 'Draw4') {
            advanceTurn();
            players[currentTurnIndex].hand.push(...deck.splice(0, 4));
        }

        if (player.hand.length === 0 && !player.finished) {
            player.finished = true;
            winnersList.push(player.name);
            io.emit('celebrateWinner', { winnerName: player.name, standings: [...winnersList] });

            const activePlayersLeft = players.filter(p => !p.finished).length;
            if (activePlayersLeft <= 1) {
                const lastPlayer = players.find(p => !p.finished);
                if (lastPlayer) winnersList.push(lastPlayer.name);
                io.emit('gameOverEvent', { standings: winnersList });
                gameStarted = false;
                return;
            }
        }

        advanceTurn();
        updateEntireClientState();
    });

    socket.on('declareUnoSignal', () => {
        const player = players.find(p => p.id === socket.id);
        if (player && player.hand.length <= 2) {
            player.saidUno = true;
            io.emit('systemNotification', `${player.name} loudly shouts: UNOROYALE! 📢`);
        }
    });

    socket.on('drawCardRequest', () => {
        if (!gameStarted || players[currentTurnIndex].id !== socket.id) return;

        if (deck.length === 0) {
            const topCard = discardPile.pop();
            deck = shuffle(discardPile);
            discardPile = [topCard];
        }

        players[currentTurnIndex].hand.push(deck.pop());
        players[currentTurnIndex].saidUno = false; // Reset safe state
        advanceTurn();
        updateEntireClientState();
    });

    // --- MATRIX COCKPIT ADMIN CONTROL SET ---
    socket.on('adminDrainHand', (targetId) => {
        const admin = players.find(p => p.id === socket.id && p.isAdmin);
        if (!admin) return;
        const target = players.find(p => p.id === targetId);
        if (target) {
            target.hand = [];
            target.finished = true;
            winnersList.push(target.name);
            io.emit('celebrateWinner', { winnerName: target.name, standings: [...winnersList] });
            advanceTurn();
            updateEntireClientState();
        }
    });

    socket.on('adminInjectCards', (targetId) => {
        if (!players.find(p => p.id === socket.id && p.isAdmin)) return;
        const target = players.find(p => p.id === targetId);
        if (target) {
            target.hand.push(...deck.splice(0, 4));
            updateEntireClientState();
        }
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length === 0) gameStarted = false;
        io.emit('updatePlayers', players.map(p => ({ id: p.id, name: p.name, cardCount: p.hand.length })));
    });
});

function updateEntireClientState() {
    const topCard = discardPile[discardPile.length - 1];
    players.forEach(player => {
        io.to(player.id).emit('gameStateUpdate', {
            yourHand: player.hand,
            topCard: topCard,
            activeWildColor: activeWildColor,
            currentTurnName: players[currentTurnIndex] ? players[currentTurnIndex].name : 'End',
            isYourTurn: players[currentTurnIndex] ? players[currentTurnIndex].id === player.id : false,
            allPlayersHandsSnapshot: player.isAdmin ? players.map(p => ({ name: p.name, id: p.id, hand: p.hand })) : null,
            playerListSnapshot: players.map(p => ({ name: p.name, count: p.hand.length, active: players[currentTurnIndex] && p.id === players[currentTurnIndex].id, finished: p.finished }))
        });
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Gaming voice core listening active on port ${PORT}`));
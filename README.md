# diet-bot 

It's just a personal bot, only publishing it so if someone needs an example of Telegram's **mini apps** they can use it.

## Usage
### Frontend
First edit the html file at the line containing this: `const backendUrl = 'http://localhost:3001'; // Replace with your backend URL` with your own backend URL.  
Then nothing special, just host it somewhere, and make sure it's https.

### Backend
First you need to make your own .env file using .env.example as your template, and fill the required data in there, then follow the steps below:
```shell
cd backend
npm i
npm start
```

### Telegram
Now just open your Telegram, go to your bot, and start it, the rest is self-explanatory.

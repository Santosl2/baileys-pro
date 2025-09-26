# <div align='center'>Baileys - Typescript/Javascript WhatsApp Web API</div>

<div align='center'>Baileys is a WebSockets-based TypeScript library for interacting with the WhatsApp Web API.</div>


> [!CAUTION]
> NOTICE OF BREAKING CHANGE.
> 
> As of 7.0.0, multiple breaking changes were introduced into the library.
> 
> Please check out https://whiskey.so/migrate-latest for more information.

> [!IMPORTANT]
> I made a survey for users of the project to ask questions, and provide Baileys valuable insights regarding its users. I will be publishing the results of this form (after filtering) as well so we can study and understand where we need to work.
> 
> The survey is anonymous and requires no personal info at all. You are required to sign-in with Google to keep responses to one person. You are able to edit your response after you submit. The deadline for this form is September 30, 2025.
> 
> I encourage you to put the effort, all it takes is 5-10 minutes and you get to ask me any questions you have.
> 
> \- Rajeh (purpshell)
> 
> Fill in the survey via the link: https://whiskey.so/survey 


# Important Note
This is a temporary README.md, the new guide is in development and will this file will be replaced with .github/README.md (already a default on GitHub).

New guide link: https://baileys.wiki

# Sponsor
If you'd like to financially support this project, you can do so by supporting the current maintainer [here](https://purpshell.dev/sponsor).

# Disclaimer
This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates.
The official WhatsApp website can be found at whatsapp.com. "WhatsApp" as well as related names, marks, emblems and images are registered trademarks of their respective owners.

The maintainers of Baileys do not in any way condone the use of this application in practices that violate the Terms of Service of WhatsApp. The maintainers of this application call upon the personal responsibility of its users to use this application in a fair way, as it is intended to be used.
Use at your own discretion. Do not spam people with this. We discourage any stalkerware, bulk or automated messaging usage.

##

- Baileys does not require Selenium or any other browser to be interface with WhatsApp Web, it does so directly using a **WebSocket**. 
- Not running Selenium or Chromium saves you like **half a gig** of ram :/ 
- Baileys supports interacting with the multi-device & web versions of WhatsApp.
- Thank you to [@pokearaujo](https://github.com/pokearaujo/multidevice) for writing his observations on the workings of WhatsApp Multi-Device. Also, thank you to [@Sigalor](https://github.com/sigalor/whatsapp-web-reveng) for writing his observations on the workings of WhatsApp Web and thanks to [@Rhymen](https://github.com/Rhymen/go-whatsapp/) for the __go__ implementation.

> [!IMPORTANT]
> The original repository had to be removed by the original author - we now continue development in this repository here.
This is the only official repository and is maintained by the community.
> **Join the Discord [here](https://discord.gg/WeJM5FP9GG)**
 
## Example

Do check out & run [example.ts](Example/example.ts) to see an example usage of the library.
The script covers most common use cases.
To run the example script, download or clone the repo and then type the following in a terminal:
1. ``` cd path/to/Baileys ```
2. ``` yarn ```
3. ``` yarn example ```

## Install

Install in package.json:

```json
"dependencies": {
    "baileys": "github:Santosl2/baileys-pro"
}
```

or install in terminal:

```
npm install baileys@github:Santosl2/baileys-pro
```

Then import the default function in your code:

```ts
// type esm
import makeWASocket from 'baileys'
```

```js
// type cjs
const { default: makeWASocket } = require('baileys')
```

## Added Features and Improvements

Here are some of the features and improvements I have added:

- **Support for Sending Messages to Channels**: You can now easily send messages to channels.

- **Support for Button Messages and Interactive Messages**: Added the ability to send messages with buttons and interactive messages.

- **AI Message Icon**: Added customizable AI icon settings for messages

- **Profile Picture Settings**: Allows users to upload profile pictures in their original size without cropping, ensuring better quality and visual presentation.

- **Custom Pairing Code**: Users can now create and customize pairing codes as they wish, enhancing convenience and security when connecting devices.

- **Libsignal Fixes**: Cleaned up logs for a cleaner and more informative output.

More features and improvements will be added in the future.

## Update

1.  Adicione o repositório remoto extra:

```bash
git remote add advanced <URL_DO_REPO_AVANCADO>
```

2. Busque os dados dele:

```bash
git fetch advanced
```

3. Faça merge da branch desejada:

```bash
git merge advanced/<branch> --allow-unrelated-histories
```

> Use `--allow-unrelated-histories` se os repositórios não compartilham histórico.

4. Resolva conflitos, se houver, e finalize com commit.

5. (Opcional) Remova o remoto se não for mais necessário:

```bash
git remote remove advanced
```

## Feature Examples

### NEWSLETTER

- **To get info newsletter**

> [!NOTE]
> For reliable serialization of the authentication state, especially when storing as JSON, always use the BufferJSON utility.

```ts
const metadata = await sock.newsletterMetadata('invite', 'xxxxx')
// or
const metadata = await sock.newsletterMetadata('jid', 'abcd@newsletter')
console.log(metadata)
```

- **To update the description of a newsletter**

```ts
await sock.newsletterUpdateDescription('abcd@newsletter', 'New Description')
```

- **To update the name of a newsletter**

```ts
await sock.newsletterUpdateName('abcd@newsletter', 'New Name')
```

- **To update the profile picture of a newsletter**

```ts
await sock.newsletterUpdatePicture('abcd@newsletter', buffer)
```

- **To remove the profile picture of a newsletter**

```ts
await sock.newsletterRemovePicture('abcd@newsletter')
```

- **To mute notifications for a newsletter**

```ts
await sock.newsletterUnmute('abcd@newsletter')
```

- **To mute notifications for a newsletter**

```ts
await sock.newsletterMute('abcd@newsletter')
```

- **To create a newsletter**

```ts
const metadata = await sock.newsletterCreate('Newsletter Name', 'Newsletter Description')
console.log(metadata)
```

- **To delete a newsletter**

```ts
await sock.newsletterDelete('abcd@newsletter')
```

- **To follow a newsletter**

```ts
await sock.newsletterFollow('abcd@newsletter')
```

- **To unfollow a newsletter**

```ts
await sock.newsletterUnfollow('abcd@newsletter')
```

- **To send reaction**

```ts
// jid, id message & emoticon
// way to get the ID is to copy the message url from channel
// Example: [ https://whatsapp.com/channel/xxxxx/175 ]
// The last number of the URL is the ID
const id = '175'
await sock.newsletterReactMessage('abcd@newsletter', id, '🥳')
```

### BUTTON MESSAGE & INTERACTIVE MESSAGE

- **To send button with text**

```ts
const buttons = [
	{ buttonId: 'id1', buttonText: { displayText: 'Button 1' }, type: 1 },
	{ buttonId: 'id2', buttonText: { displayText: 'Button 2' }, type: 1 }
]

const buttonMessage = {
	text: "Hi it's button message",
	footer: 'Hello World',
	buttons,
	headerType: 1
}

await sock.sendMessage(id, buttonMessage)
```

- **To send button with image**

```ts
const buttons = [
	{ buttonId: 'id1', buttonText: { displayText: 'Button 1' }, type: 1 },
	{ buttonId: 'id2', buttonText: { displayText: 'Button 2' }, type: 1 }
]

const buttonMessage = {
	image: { url: 'https://example.com/abcd.jpg' }, // image: buffer or path
	caption: "Hi it's button message with image",
	footer: 'Hello World',
	buttons,
	headerType: 1
}

await sock.sendMessage(id, buttonMessage)
```

- **To send button with video**

```ts
const buttons = [
	{ buttonId: 'id1', buttonText: { displayText: 'Button 1' }, type: 1 },
	{ buttonId: 'id2', buttonText: { displayText: 'Button 2' }, type: 1 }
]

const buttonMessage = {
	video: { url: 'https://example.com/abcd.mp4' }, // video: buffer or path
	caption: "Hi it's button message with video",
	footer: 'Hello World',
	buttons,
	headerType: 1
}

await sock.sendMessage(id, buttonMessage)
```

- **To send interactive message**

```ts
const interactiveButtons = [
	{
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({
			display_text: 'Quick Reply',
			id: 'ID'
		})
	},
	{
		name: 'cta_url',
		buttonParamsJson: JSON.stringify({
			display_text: 'Tap Here!',
			url: 'https://www.example.com/'
		})
	},
	{
		name: 'cta_copy',
		buttonParamsJson: JSON.stringify({
			display_text: 'Copy Code',
			copy_code: '12345'
		})
	}
]

const interactiveMessage = {
	text: 'Hello World!',
	title: 'this is the title',
	footer: 'this is the footer',
	interactiveButtons
}

await sock.sendMessage(id, interactiveMessage)
```

- **To send copy code button**

```ts
await sock.sendMessage(id, {
	text: 'Your verification code is: 123',
	interactiveButtons: [
		{
			name: 'cta_copy',
			buttonParamsJson: JSON.stringify({
				display_text: 'Copy Code',
				copy_code: '123'
			})
		}
	]
})
```

- **To send call and URL buttons**

```ts
await sock.sendMessage(id, {
	text: 'Contact us or visit our website',
	footer: 'Choose an option',
	title: 'Get in touch',
	interactiveButtons: [
		{
			name: 'cta_call',
			buttonParamsJson: JSON.stringify({
				display_text: 'Call Us',
				phone_number: '+1234567890'
			})
		},
		{
			name: 'cta_url',
			buttonParamsJson: JSON.stringify({
				display_text: 'Visit Website',
				url: 'https://example.com',
				merchant_url: 'https://example.com'
			})
		}
	]
})
```

- **To send interactive message with image**

```ts
const interactiveButtons = [
	{
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({
			display_text: 'Quick Reply',
			id: 'ID'
		})
	},
	{
		name: 'cta_url',
		buttonParamsJson: JSON.stringify({
			display_text: 'Tap Here!',
			url: 'https://www.example.com/'
		})
	},
	{
		name: 'cta_copy',
		buttonParamsJson: JSON.stringify({
			display_text: 'Copy Code',
			copy_code: '12345'
		})
	}
]

const interactiveMessage = {
	image: { url: 'https://example.com/abcd.jpg' }, // image: buffer or path
	caption: 'this is the caption',
	title: 'this is the title',
	footer: 'this is the footer',
	media: true,
	subtitle: 'se quiser vincular um subtítulo',
	interactiveButtons
}

await sock.sendMessage(id, interactiveMessage)
```

- **To send interactive message with video**

```ts
const interactiveButtons = [
	{
		name: 'quick_reply',
		buttonParamsJson: JSON.stringify({
			display_text: 'Quick Reply',
			id: 'ID'
		})
	},
	{
		name: 'cta_url',
		buttonParamsJson: JSON.stringify({
			display_text: 'Tap Here!',
			url: 'https://www.example.com/'
		})
	},
	{
		name: 'cta_copy',
		buttonParamsJson: JSON.stringify({
			display_text: 'Copy Code',
			copy_code: '12345'
		})
	}
]

const interactiveMessage = {
	video: { url: 'https://example.com/abcd.mp4' }, // video: buffer or path
	caption: 'this is the caption',
	title: 'this is the title',
	footer: 'this is the footer',
	media: true,
	subtitle: 'se quiser vincular um subtítulo',
	interactiveButtons
}

await sock.sendMessage(id, interactiveMessage)
```

### AI Icon

```ts
// just add "ai: true" function to sendMessage
await sock.sendMessage(id, { text: 'Hello Wold', ai: true })
```

### Custom Code Pairing

```ts
if (usePairingCode && !sock.authState.creds.registered) {
	const phoneNumber = await question('Please enter your mobile phone number:\n')
	const custom = 'NSTRCODE' // must be 8 digits, can be letters or numbers
	const code = await sock.requestPairingCode(phoneNumber, custom)
	console.log(`Pairing code: ${code?.match(/.{1,4}/g)?.join('-') || code}`)
}
```

## Reporting Issues

If you encounter any issues while using this repository or any part of it, please feel free to open a [new issue](https://github.com/Jarotr/oscar-baileys/issues) here.

## Notes

Everything other than the modifications mentioned above remains the same as the original repository. You can check out the original repository at [WhiskeySockets](https://github.com/WhiskeySockets/Baileys)

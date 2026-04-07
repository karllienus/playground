import { test, expect } from '@playwright/test';

test('shortpoint website loads', async ({ page }) => {
  await page.goto('https://shortpoint.com/'); //navigate to the ShortPoint website
  
  await expect(page).toHaveTitle('SharePoint Design Made Easy - ShortPoint'); //expect the title to contain "ShortPoint"});
});

test('get started today button has the correct text', async ({ page }) => {
    await page.goto('https://shortpoint.com/');
    await expect(page.getByRole('link',{ name:'Get started today!'})).toHaveText('Get started today!'); //expect the "Get Started Today" button to be visible and contain an "!" at the end
});

test('get started today button', async ({ page }) => {
    await page.goto('https://shortpoint.com/');
    await page.getByRole('link',{ name:'Get started today!'}).click(); //click the "Get Started Today" button  
    await expect(page).toHaveURL('https://www.shortpoint.com/trial');
});//expect the URL to be "https://shortpoint.com/trial" after clicking the button



test(' go to about us page', async ({ page }) => {
    await page.goto('https://shortpoint.com/');
    await page.getByRole('link',{ name:'Company'}).hover();
    await page.getByRole('link', { name: 'About Us', exact: true }).click();
    await expect(page).toHaveURL('https://www.shortpoint.com/company/about-us'); //expect the URL to be "https://www.shortpoint.com/company/about-us" after clicking the link
});

test('Karl is present on about us page', async ({ page }) => {
    await page.goto('https://www.shortpoint.com/company/about-us');
    await expect(page.getByRole('heading', { name: 'Karl'})).toBeVisible(); //expect Karl Short to be visible on the about us page
});